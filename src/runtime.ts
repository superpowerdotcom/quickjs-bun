import assert from "node:assert/strict";
import { CString, JSCallback, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { JSContext } from "./context";
import {
  bytes,
  cstring,
  encoder,
  QUICKJS_DEFAULT_STACK_SIZE,
  QuickJSValueTag,
  type QuickJS,
  type QuickJSNative,
} from "./ffi";
import type {
  HostFunction,
  JSClassOptions,
  JSContextOptions,
  JSMemoryUsage,
  JSModuleLoader,
  JSModuleNormalizer,
  JSPromiseRejectionTracker,
  JSRuntimeOptions,
} from "./types";
import { JSException, JSModule, JSValue } from "./value";

export class JSRuntime {
  readonly library: QuickJS;
  readonly native: QuickJSNative;
  readonly contexts = new Map<Pointer, JSContext>();
  readonly callbacks: JSCallback[] = [];
  hostDepth = 0;

  #runtime: Pointer;
  #disposed = false;
  #hosts: (HostFunction | Uint8Array | undefined)[] = [];
  #freeSlots: number[] = [];
  #hostCallback: JSCallback;
  #moduleLoader?: JSModuleLoader;
  #moduleNormalizer?: JSModuleNormalizer;
  #loaderCallback?: JSCallback;
  #normalizerCallback?: JSCallback;
  #rejectionTracker?: JSPromiseRejectionTracker;
  #rejectionCallback?: JSCallback;
  #runtimeInfo?: Uint8Array;

  constructor(options: JSRuntimeOptions) {
    const memoryBytes = options.memoryBytes ?? 64 * 1024 * 1024;
    const stackBytes = options.stackBytes ?? QUICKJS_DEFAULT_STACK_SIZE;
    assert(
      Number.isSafeInteger(memoryBytes) && memoryBytes > 0,
      "memoryBytes must be a positive safe integer",
    );
    assert(
      Number.isSafeInteger(stackBytes) && stackBytes > 0,
      "stackBytes must be a positive safe integer",
    );
    this.library = options.library;
    this.native = this.library.native;
    const runtime = this.native.qjs_bun_new_runtime();
    assert(typeof runtime === "number", "QuickJS runtime did not initialize");
    this.#runtime = runtime;
    this.#hostCallback = new JSCallback((request: Pointer) => this.#callHost(request), {
      args: ["ptr"],
      returns: "void",
    });
    this.setMemoryLimit(memoryBytes);
    this.setMaxStackSize(stackBytes);
    if (options.gcThresholdBytes !== undefined) this.setGCThreshold(options.gcThresholdBytes);
    if (options.canBlock !== undefined) this.setCanBlock(options.canBlock);
    if (options.runtimeInfo !== undefined) this.setRuntimeInfo(options.runtimeInfo);
    if (options.stripInfo !== undefined) this.setStripInfo(options.stripInfo);
  }

  get ptr(): Pointer {
    assert(!this.#disposed, "QuickJS runtime is disposed");
    return this.#runtime;
  }

  get hostCallback(): Pointer {
    const pointer = this.#hostCallback.ptr;
    assert(pointer !== null, "QuickJS host callback is closed");
    return pointer;
  }

  slot(value: HostFunction | Uint8Array): number {
    const id = this.#freeSlots.pop() ?? this.#hosts.length;
    this.#hosts[id] = value;
    return id;
  }

  release(id: number): void {
    if (this.#hosts[id] === undefined) return;
    this.#hosts[id] = undefined;
    this.#freeSlots.push(id);
  }

  createContext(options: JSContextOptions = {}): JSContext {
    return new JSContext(this, options);
  }

  setModuleLoader(loader: JSModuleLoader | null, normalizer?: JSModuleNormalizer): void {
    this.#moduleLoader = loader ?? undefined;
    this.#moduleNormalizer = normalizer;
    if (loader === null) {
      this.native.qjs_bun_set_module_loader(this.ptr, null, null);
      return;
    }
    this.#loaderCallback ??= new JSCallback(
      (context: Pointer, name: Pointer, attributes: Pointer) =>
        this.#loadModule(context, name, attributes),
      { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
    );
    if (normalizer !== undefined) {
      this.#normalizerCallback ??= new JSCallback(
        (context: Pointer, base: Pointer, name: Pointer) =>
          this.#normalizeModule(context, base, name),
        { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
      );
    }
    this.native.qjs_bun_set_module_loader(
      this.ptr,
      this.#loaderCallback.ptr,
      normalizer === undefined ? null : this.#normalizerCallback!.ptr,
    );
  }

  setPromiseRejectionTracker(tracker: JSPromiseRejectionTracker | null): void {
    this.#rejectionTracker = tracker ?? undefined;
    if (tracker === null) {
      this.native.qjs_bun_set_promise_rejection_tracker(this.ptr, null);
      return;
    }
    this.#rejectionCallback ??= new JSCallback(
      (context: Pointer, promise: Pointer, reason: Pointer, isHandled: number) =>
        this.#trackRejection(context, promise, reason, isHandled),
      { args: ["ptr", "ptr", "ptr", "i32"], returns: "void" },
    );
    this.native.qjs_bun_set_promise_rejection_tracker(this.ptr, this.#rejectionCallback.ptr);
  }

  newClassId(): number {
    return this.native.JS_NewClassID(new Uint32Array(1));
  }

  registerClass(name: string, options: JSClassOptions & { classId?: number } = {}): number {
    const classId = options.classId ?? this.newClassId();
    assert(Number.isInteger(classId) && classId > 0, "classId must be a positive safe integer");
    let finalizer: JSCallback | undefined;
    if (options.finalizer !== undefined) {
      const callback = options.finalizer;
      finalizer = new JSCallback(
        (opaque: Pointer | null) => {
          this.hostDepth++;
          try {
            callback(opaque);
          } catch {
          } finally {
            this.hostDepth--;
          }
        },
        { args: ["ptr"], returns: "void" },
      );
      this.callbacks.push(finalizer);
    }
    const ok = this.native.qjs_bun_new_class(
      this.ptr,
      classId,
      cstring(name),
      finalizer?.ptr ?? null,
    );
    assert(ok >= 0, "JS_NewClass failed");
    return classId;
  }

  isRegisteredClass(classId: number): boolean {
    return this.native.JS_IsRegisteredClass(this.ptr, classId) !== 0;
  }

  getOpaque(): Pointer | null {
    const opaque = this.native.JS_GetRuntimeOpaque(this.ptr);
    return typeof opaque === "number" ? opaque : null;
  }

  setOpaque(opaque: Pointer | null): void {
    this.native.JS_SetRuntimeOpaque(this.ptr, opaque);
  }

  setRuntimeInfo(info: string): void {
    this.#runtimeInfo = cstring(info);
    this.native.JS_SetRuntimeInfo(this.ptr, this.#runtimeInfo);
  }

  setMemoryLimit(bytes: number): void {
    assert(Number.isSafeInteger(bytes) && bytes > 0, "memoryBytes must be a positive safe integer");
    this.native.JS_SetMemoryLimit(this.ptr, bytes);
  }

  setGCThreshold(bytes: number): void {
    assert(
      Number.isSafeInteger(bytes) && bytes >= 0,
      "gcThresholdBytes must be a non-negative safe integer",
    );
    this.native.JS_SetGCThreshold(this.ptr, bytes);
  }

  setMaxStackSize(bytes: number): void {
    assert(
      Number.isSafeInteger(bytes) && bytes >= 0,
      "stackBytes must be a non-negative safe integer",
    );
    this.native.JS_SetMaxStackSize(this.ptr, bytes);
  }

  updateStackTop(): void {
    this.native.JS_UpdateStackTop(this.ptr);
  }

  setCanBlock(canBlock: boolean): void {
    this.native.JS_SetCanBlock(this.ptr, canBlock ? 1 : 0);
  }

  setStripInfo(flags: number): void {
    assert(Number.isInteger(flags) && flags >= 0, "stripInfo must be a non-negative safe integer");
    this.native.JS_SetStripInfo(this.ptr, flags);
  }

  getStripInfo(): number {
    return this.native.JS_GetStripInfo(this.ptr);
  }

  memoryUsage(): JSMemoryUsage {
    const usage = new BigInt64Array(26);
    this.native.JS_ComputeMemoryUsage(this.ptr, usage);
    return {
      mallocSize: usage[0]!,
      mallocLimit: usage[1]!,
      memoryUsedSize: usage[2]!,
      mallocCount: usage[3]!,
      memoryUsedCount: usage[4]!,
      atomCount: usage[5]!,
      atomSize: usage[6]!,
      strCount: usage[7]!,
      strSize: usage[8]!,
      objCount: usage[9]!,
      objSize: usage[10]!,
      propCount: usage[11]!,
      propSize: usage[12]!,
      shapeCount: usage[13]!,
      shapeSize: usage[14]!,
      jsFuncCount: usage[15]!,
      jsFuncSize: usage[16]!,
      jsFuncCodeSize: usage[17]!,
      jsFuncPc2LineCount: usage[18]!,
      jsFuncPc2LineSize: usage[19]!,
      cFuncCount: usage[20]!,
      arrayCount: usage[21]!,
      fastArrayCount: usage[22]!,
      fastArrayElements: usage[23]!,
      binaryObjectCount: usage[24]!,
      binaryObjectSize: usage[25]!,
    };
  }

  memoryUsedBytes(): bigint {
    return this.memoryUsage().memoryUsedSize;
  }

  dumpMemoryUsage(): string {
    const length = new BigUint64Array(1);
    const text = this.native.qjs_bun_dump_memory_usage(this.ptr, length);
    assert(typeof text === "number", "JS_DumpMemoryUsage failed");
    try {
      return new CString(text, 0, Number(length[0]!)) as string;
    } finally {
      this.native.js_free_rt(this.ptr, text);
    }
  }

  runGC(): void {
    this.native.JS_RunGC(this.ptr);
  }

  hasPendingJob(): boolean {
    return this.native.JS_IsJobPending(this.ptr) !== 0;
  }

  executePendingJob(timeoutMs = 1000): boolean {
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeoutMs must be positive");
    const out = new BigUint64Array(1);
    const status = this.native.qjs_bun_execute_pending_job(this.ptr, timeoutMs, out);
    if (status >= 0) return status > 0;
    const context =
      this.contexts.get(Number(out[0]!) as Pointer) ?? this.contexts.values().next().value;
    assert(context !== undefined, "QuickJS job failed in a disposed context");
    throw context.getException();
  }

  executePendingJobs(timeoutMs = 1000): number {
    let count = 0;
    while (this.executePendingJob(timeoutMs)) count++;
    return count;
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const context of this.contexts.values()) context.dispose();
    this.native.qjs_bun_free_runtime(this.#runtime);
    this.#disposed = true;
    for (const callback of this.callbacks) callback.close();
    this.callbacks.length = 0;
    this.#hostCallback.close();
    this.#loaderCallback?.close();
    this.#normalizerCallback?.close();
    this.#rejectionCallback?.close();
    this.#hosts.length = 0;
    this.#freeSlots.length = 0;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #callHost(request: Pointer): void {
    const id = read.u32(request, 4);
    if (read.u32(request, 0) !== 0) {
      this.release(id);
      return;
    }
    const out = new Uint8Array(toArrayBuffer(request, 48, 16));
    const pointer = read.ptr(request, 8) as Pointer;
    const context = this.contexts.get(pointer);
    const host = this.#hosts[id];
    if (context === undefined || typeof host !== "function") {
      this.native.qjs_bun_throw_error(pointer, 4, cstring("QuickJS host function is unavailable"));
      out.fill(0);
      out[8] = QuickJSValueTag.EXCEPTION;
      return;
    }
    const argc = read.u32(request, 16);
    const thisValue = this.#borrow(context, request, 24);
    const args: JSValue[] = [];
    this.hostDepth++;
    try {
      const argv = read.ptr(request, 40) as Pointer;
      for (let index = 0; index < argc; index++) args.push(this.#borrow(context, argv, index * 16));
      const result = host.call(thisValue, ...args);
      const handle = result instanceof JSValue ? result : context.newValue(result);
      context.assertSameVM(handle);
      if (handle.tag < 0) this.native.qjs_bun_dup_value(context.ctx, out, handle.ptr);
      else out.set(handle.cell);
      handle.dispose();
    } catch (error) {
      try {
        const thrown =
          error instanceof JSException
            ? error.value
            : error instanceof JSValue
              ? error
              : context.newError(error instanceof Error ? error : new Error(String(error)));
        context.assertSameVM(thrown);
        this.native.qjs_bun_throw(context.ctx, out, thrown.ptr);
        thrown.dispose();
      } catch (failure) {
        if (failure instanceof JSException) failure.dispose();
        if (context.disposed) {
          this.native.qjs_bun_throw_error(pointer, 4, cstring("QuickJS context is disposed"));
          out.fill(0);
          out[8] = QuickJSValueTag.EXCEPTION;
        } else {
          this.native.qjs_bun_throw_out_of_memory(context.ctx, out);
        }
      }
    } finally {
      this.hostDepth--;
      thisValue.dispose();
      for (const arg of args) arg.dispose();
    }
  }

  #borrow(context: JSContext, source: Pointer, offset: number): JSValue {
    const cell = new Uint8Array(16);
    cell.set(new Uint8Array(toArrayBuffer(source, offset, 16)));
    const value = new JSValue(context, cell, true);
    if (value.tag < 0) this.native.qjs_bun_dup_value(context.ctx, cell, value.ptr);
    return value;
  }

  #loadModule(pointer: Pointer, name: Pointer, attributes: Pointer): Pointer | null {
    const moduleName = new CString(name) as string;
    this.hostDepth++;
    try {
      const context = this.contexts.get(pointer);
      assert(context !== undefined, "QuickJS module context is not registered");
      const source = this.#moduleLoader?.(
        moduleName,
        context,
        new JSValue(context, new Uint8Array(toArrayBuffer(attributes, 0, 16)), false),
      );
      if (source === null || source === undefined) {
        this.native.qjs_bun_throw_error(
          pointer,
          2,
          cstring(`Could not load module '${moduleName}'`),
        );
        return null;
      }
      if (source instanceof JSModule) {
        assert(source.vm === context, "QuickJS module belongs to another context");
        return source.ptr;
      }
      const code = Buffer.concat([
        typeof source === "string" ? encoder.encode(source) : bytes(source),
        Buffer.from([0]),
      ]);
      const module = this.native.qjs_bun_compile_module(
        pointer,
        code,
        code.byteLength - 1,
        cstring(moduleName),
      );
      return typeof module === "number" ? module : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.native.qjs_bun_throw_error(pointer, 4, cstring(message));
      return null;
    } finally {
      this.hostDepth--;
    }
  }

  #normalizeModule(pointer: Pointer, base: Pointer, name: Pointer): Pointer | null {
    this.hostDepth++;
    try {
      const context = this.contexts.get(pointer);
      assert(context !== undefined, "QuickJS module context is not registered");
      const resolved = cstring(
        this.#moduleNormalizer!(new CString(base) as string, new CString(name) as string, context),
      );
      const buffer = this.native.js_malloc(pointer, resolved.length);
      assert(typeof buffer === "number", "QuickJS could not allocate the module name");
      new Uint8Array(toArrayBuffer(buffer, 0, resolved.length)).set(resolved);
      return buffer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.native.qjs_bun_throw_error(pointer, 4, cstring(message));
      return null;
    } finally {
      this.hostDepth--;
    }
  }

  #trackRejection(pointer: Pointer, promise: Pointer, reason: Pointer, isHandled: number): void {
    this.hostDepth++;
    try {
      const context = this.contexts.get(pointer);
      if (context === undefined) return;
      this.#rejectionTracker?.({
        context,
        isHandled: isHandled !== 0,
        promise: new JSValue(context, new Uint8Array(toArrayBuffer(promise, 0, 16)), false),
        reason: new JSValue(context, new Uint8Array(toArrayBuffer(reason, 0, 16)), false),
      });
    } catch {
    } finally {
      this.hostDepth--;
    }
  }
}
