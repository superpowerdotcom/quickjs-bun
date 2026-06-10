import assert from "node:assert/strict";
import { CString, JSCallback, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { QUICKJS_DEFAULT_STACK_SIZE, type QuickJS, type QuickJSNative } from "./ffi";
import { JSContext } from "./context";
import {
  VALUE_CELL_BYTES,
  bytesView,
  encodeCString,
  encoder,
  pointerKey,
  throwQuickJSError,
} from "./internal";
import { JSModule } from "./module";
import { JSValue } from "./value";
import type {
  JSContextOptions,
  JSMemoryUsage,
  JSModuleLoader,
  JSPromiseRejectionTracker,
  JSRuntimeOptions,
} from "./types";

export class JSRuntime {
  readonly library: QuickJS;
  readonly native: QuickJSNative;

  #runtime: Pointer;
  #disposed = false;
  #interruptCallback: JSCallback;
  #interruptScopes: { own: number; effective: number }[] = [];
  #interruptDeadlineMs = Number.POSITIVE_INFINITY;
  #contexts = new Set<JSContext>();
  #contextByPointer = new Map<string, JSContext>();
  #moduleLoader?: JSModuleLoader;
  #moduleLoaderCallback?: JSCallback;
  #promiseRejectionTracker?: JSPromiseRejectionTracker;
  #promiseRejectionTrackerCallback?: JSCallback;
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
    if (options.gcThresholdBytes !== undefined) {
      assert(
        Number.isSafeInteger(options.gcThresholdBytes) && options.gcThresholdBytes >= 0,
        "gcThresholdBytes must be a non-negative safe integer",
      );
    }
    if (options.stripInfo !== undefined) {
      assert(
        Number.isSafeInteger(options.stripInfo) && options.stripInfo >= 0,
        "stripInfo must be a non-negative safe integer",
      );
    }

    this.library = options.library;
    this.native = this.library.native;

    const runtime = this.native.JS_NewRuntime();
    assert(runtime !== null, "QuickJS runtime did not initialize");
    this.#runtime = runtime;
    this.library.registerRuntime(this);
    this.library.ensureHostSlotFinalizer();
    assert(
      this.native.qjs_bun_init_host_slot_class(runtime) >= 0,
      "qjs_bun_init_host_slot_class failed",
    );

    this.#interruptCallback = new JSCallback(() => this.#interrupt(), {
      args: ["ptr", "ptr"],
      returns: "i32",
    });
    assert(this.#interruptCallback.ptr !== null, "Interrupt callback pointer is null");

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

  createContext(options: JSContextOptions = {}): JSContext {
    return new JSContext(this, options);
  }

  setModuleLoader(loader: JSModuleLoader | null): void {
    this.#moduleLoader = loader ?? undefined;
    if (loader === null) {
      this.native.JS_SetModuleLoaderFunc(this.ptr, null, null, null);
      this.#moduleLoaderCallback?.close();
      this.#moduleLoaderCallback = undefined;
      return;
    }
    if (this.#moduleLoaderCallback === undefined) {
      this.#moduleLoaderCallback = new JSCallback(
        (context: Pointer, moduleName: Pointer, attributes: Pointer) =>
          this.#loadModule(context, moduleName, attributes),
        { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
      );
      assert(this.#moduleLoaderCallback.ptr !== null, "Module loader callback pointer is null");
    }
    this.native.qjs_bun_set_module_loader_func2(this.ptr, this.#moduleLoaderCallback.ptr);
  }

  setPromiseRejectionTracker(tracker: JSPromiseRejectionTracker | null): void {
    this.#promiseRejectionTracker = tracker ?? undefined;
    if (tracker === null) {
      this.native.qjs_bun_set_host_promise_rejection_tracker(this.ptr, null);
      this.#promiseRejectionTrackerCallback?.close();
      this.#promiseRejectionTrackerCallback = undefined;
      return;
    }
    if (this.#promiseRejectionTrackerCallback === undefined) {
      this.#promiseRejectionTrackerCallback = new JSCallback(
        (context: Pointer, promise: Pointer, reason: Pointer, isHandled: number) =>
          this.#trackPromiseRejection(context, promise, reason, isHandled),
        { args: ["ptr", "ptr", "ptr", "i32"], returns: "void" },
      );
      assert(
        this.#promiseRejectionTrackerCallback.ptr !== null,
        "Promise rejection tracker callback pointer is null",
      );
    }
    this.native.qjs_bun_set_host_promise_rejection_tracker(
      this.ptr,
      this.#promiseRejectionTrackerCallback.ptr,
    );
  }

  getOpaque(): Pointer | null {
    return this.native.JS_GetRuntimeOpaque(this.ptr) as Pointer | null;
  }

  setOpaque(opaque: Pointer | null): void {
    this.native.JS_SetRuntimeOpaque(this.ptr, opaque);
  }

  newClassId(): number {
    return this.native.JS_NewClassID(new Uint32Array(1));
  }

  registerClass(name: string, classId = this.newClassId()): number {
    assert(Number.isSafeInteger(classId) && classId > 0, "classId must be a positive safe integer");
    const className = encoder.encode(`${name}\0`);
    assert(this.native.qjs_bun_new_class(this.ptr, classId, className) >= 0, "JS_NewClass failed");
    return classId;
  }

  isRegisteredClass(classId: number): boolean {
    assert(
      Number.isSafeInteger(classId) && classId >= 0,
      "classId must be a non-negative safe integer",
    );
    return this.native.JS_IsRegisteredClass(this.ptr, classId) !== 0;
  }

  dispatchHostSlotFinalize(contextPointer: Pointer, hostId: number): void {
    if (this.#disposed) return;
    const context = this.#contextByPointer.get(pointerKey(contextPointer));
    context?.freeHostSlot(hostId);
  }

  setRuntimeInfo(info: string): void {
    this.#runtimeInfo = encodeCString(info);
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
    assert(
      Number.isSafeInteger(flags) && flags >= 0,
      "stripInfo must be a non-negative safe integer",
    );
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
    assert(text !== null, "JS_DumpMemoryUsage failed");
    try {
      return length[0] === 0n ? "" : String(new CString(text, 0, Number(length[0]!)));
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
    const contextOut = new Uint8Array(8);
    this.startInterrupt(timeoutMs);
    const status = this.native.JS_ExecutePendingJob(this.ptr, contextOut);
    const timedOut = this.endInterrupt();
    if (status < 0) {
      const contextPointer = read.ptr(ptr(contextOut)) as Pointer | null;
      assert(contextPointer !== null, "QuickJS job context is null");
      const context = this.#contextByPointer.get(pointerKey(contextPointer));
      assert(context !== undefined, "QuickJS job context is not registered");
      throw context.getException(timedOut);
    }
    return status > 0;
  }

  executePendingJobs(timeoutMs = 1000): number {
    let count = 0;
    while (this.executePendingJob(timeoutMs)) count++;
    return count;
  }

  registerContext(context: JSContext): void {
    this.#contexts.add(context);
    this.#contextByPointer.set(pointerKey(context.ctx), context);
  }

  unregisterContext(context: JSContext): void {
    this.#contexts.delete(context);
    this.#contextByPointer.delete(pointerKey(context.ctx));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.native.JS_SetModuleLoaderFunc(this.ptr, null, null, null);
    this.native.qjs_bun_set_host_promise_rejection_tracker(this.ptr, null);
    this.#moduleLoaderCallback?.close();
    this.#moduleLoaderCallback = undefined;
    this.#promiseRejectionTrackerCallback?.close();
    this.#promiseRejectionTrackerCallback = undefined;
    for (const context of this.#contexts) context.dispose();
    this.library.unregisterRuntime(this);
    this.#disposed = true;
    this.native.JS_FreeRuntime(this.#runtime);
    this.#interruptCallback.close();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  startInterrupt(timeoutMs: number): void {
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeoutMs must be positive");
    const own = performance.now() + timeoutMs;
    const parent = this.#interruptScopes.at(-1);
    const effective = parent === undefined ? own : Math.min(own, parent.effective);
    this.#interruptScopes.push({ own, effective });
    this.#interruptDeadlineMs = effective;
    if (this.#interruptScopes.length === 1) {
      this.native.JS_SetInterruptHandler(this.ptr, this.#interruptCallback.ptr, null);
    }
  }

  endInterrupt(): boolean {
    const scope = this.#interruptScopes.pop();
    const timedOut = scope !== undefined && performance.now() > scope.own;
    const parent = this.#interruptScopes.at(-1);
    this.#interruptDeadlineMs = parent === undefined ? Number.POSITIVE_INFINITY : parent.effective;
    if (this.#interruptScopes.length === 0) {
      this.native.JS_SetInterruptHandler(this.ptr, null, null);
    }
    return timedOut;
  }

  #interrupt(): number {
    return performance.now() > this.#interruptDeadlineMs ? 1 : 0;
  }

  #loadModule(
    contextPointer: Pointer,
    moduleNamePointer: Pointer,
    attributesPointer: Pointer,
  ): Pointer | null {
    const context = this.#contextByPointer.get(pointerKey(contextPointer));
    if (context === undefined) {
      throwQuickJSError(
        this.native,
        contextPointer,
        "reference",
        "QuickJS module context is not registered",
      );
      return null;
    }
    const moduleName = String(new CString(moduleNamePointer));
    const attributes = new JSValue(
      context,
      new Uint8Array(toArrayBuffer(attributesPointer, 0, VALUE_CELL_BYTES)),
      false,
    );
    try {
      const source = this.#moduleLoader?.(moduleName, context, attributes);
      if (source === null || source === undefined) {
        throwQuickJSError(
          this.native,
          contextPointer,
          "reference",
          `Could not load module '${moduleName}'`,
        );
        return null;
      }
      if (source instanceof JSModule) {
        assert(source.vm === context, "QuickJS module belongs to another context");
        return source.ptr;
      }
      const bytes = typeof source === "string" ? encoder.encode(source) : bytesView(source);
      const filename = encoder.encode(`${moduleName}\0`);
      return this.native.qjs_bun_compile_module(
        contextPointer,
        bytes,
        bytes.byteLength,
        filename,
      ) as Pointer | null;
    } catch (error) {
      throwQuickJSError(
        this.native,
        contextPointer,
        "internal",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  #trackPromiseRejection(
    contextPointer: Pointer,
    promisePointer: Pointer,
    reasonPointer: Pointer,
    isHandled: number,
  ): void {
    const context = this.#contextByPointer.get(pointerKey(contextPointer));
    assert(context !== undefined, "QuickJS promise rejection context is not registered");
    this.#promiseRejectionTracker?.({
      context,
      isHandled: isHandled !== 0,
      promise: new JSValue(
        context,
        new Uint8Array(toArrayBuffer(promisePointer, 0, VALUE_CELL_BYTES)),
        false,
      ),
      reason: new JSValue(
        context,
        new Uint8Array(toArrayBuffer(reasonPointer, 0, VALUE_CELL_BYTES)),
        false,
      ),
    });
  }
}
