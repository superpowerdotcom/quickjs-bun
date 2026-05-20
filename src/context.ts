import assert from "node:assert/strict";
import { JSCallback, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { JSAtom } from "./atom";
import { Deferred } from "./deferred";
import { JSException } from "./exception";
import {
  QuickJSAtom,
  QuickJSEvalFlags,
  QuickJSParseJsonFlags,
  QuickJSValueTag,
  type QuickJS,
  type QuickJSNative,
} from "./ffi";
import {
  HOST_REQUEST_ARGC_OFFSET,
  HOST_REQUEST_ARGV_OFFSET,
  HOST_REQUEST_HOST_ID_OFFSET,
  HOST_REQUEST_OUT_OFFSET,
  HOST_REQUEST_THIS_OFFSET,
  MAX_HOST_FUNCTION_ID,
  MAX_INT64,
  MAX_UINT64,
  MIN_INT64,
  VALUE_CELL_BYTES,
  argvCell,
  bytesView,
  defaultIntrinsics,
  encoder,
  newCell,
  throwQuickJSError,
  valueTag,
  writeNumber,
  writeTaggedInt,
} from "./internal";
import { JSModule } from "./module";
import { JSRuntime } from "./runtime";
import { JSValue } from "./value";
import type {
  HostFunction,
  HostValue,
  JSBytes,
  JSContextOptions,
  JSEvalOptions,
  JSIntrinsic,
  JSIntrinsics,
  JSJsonParseOptions,
  JSModuleInit,
  JSTypedArrayType,
} from "./types";

export class JSContext {
  readonly library: QuickJS;
  readonly native: QuickJSNative;
  readonly runtime: JSRuntime;

  #context: Pointer;
  #disposed = false;
  #timeoutMs: number;
  #hosts: (HostFunction | undefined)[] = [];
  #freeHostSlots: number[] = [];
  #hostCallback: JSCallback;
  #moduleCallbacks: JSCallback[] = [];

  readonly undefined: JSValue;
  readonly null: JSValue;
  readonly true: JSValue;
  readonly false: JSValue;

  constructor(runtime: JSRuntime, options: JSContextOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 1000;
    assert(Number.isFinite(this.#timeoutMs) && this.#timeoutMs > 0, "timeoutMs must be positive");

    this.runtime = runtime;
    this.library = runtime.library;
    this.native = runtime.native;

    this.#hostCallback = new JSCallback((request: Pointer) => this.#callHost(request), {
      args: ["ptr"],
      returns: "void",
    });
    assert(this.#hostCallback.ptr !== null, "Host callback pointer is null");

    const intrinsics = options.intrinsics ?? "default";
    const context =
      intrinsics === "default"
        ? this.native.JS_NewContext(runtime.ptr)
        : this.native.JS_NewContextRaw(runtime.ptr);
    if (context === null) this.#hostCallback.close();
    assert(context !== null, "QuickJS context did not initialize");
    this.#context = context;
    this.runtime.registerContext(this);

    try {
      if (intrinsics !== "default") this.addIntrinsics(intrinsics);
    } catch (error) {
      this.dispose();
      throw error;
    }

    this.undefined = new JSValue(this, writeTaggedInt(QuickJSValueTag.UNDEFINED, 0), false);
    this.null = new JSValue(this, writeTaggedInt(QuickJSValueTag.NULL, 0), false);
    this.true = new JSValue(this, writeTaggedInt(QuickJSValueTag.BOOL, 1), false);
    this.false = new JSValue(this, writeTaggedInt(QuickJSValueTag.BOOL, 0), false);
  }

  get ptr(): Pointer {
    return this.ctx;
  }

  get ctx(): Pointer {
    assert(!this.#disposed, "QuickJS context is disposed");
    return this.#context;
  }

  getOpaque(): Pointer | null {
    return this.native.JS_GetContextOpaque(this.ctx) as Pointer | null;
  }

  setOpaque(opaque: Pointer | null): void {
    this.native.JS_SetContextOpaque(this.ctx, opaque);
  }

  assertSameVM(...values: JSValue[]): void {
    for (const value of values) {
      assert(value.vm === this, "JSValue belongs to another VM");
    }
  }

  hasException(): boolean {
    return this.native.JS_HasException(this.ctx) !== 0;
  }

  getException(timedOut = false): JSException {
    const out = newCell();
    this.native.qjs_bun_get_exception(this.ctx, out);
    if (timedOut) {
      this.native.qjs_bun_free_value(this.ctx, ptr(out));
      return this.#timeoutException();
    }
    return new JSException(new JSValue(this, out, true));
  }

  resultValue(cell: Uint8Array, timedOut = false): JSValue {
    if (valueTag(ptr(cell)) !== QuickJSValueTag.EXCEPTION) {
      return new JSValue(this, cell, true);
    }
    throw this.getException(timedOut);
  }

  setUncatchableException(uncatchable: boolean): void {
    this.native.JS_SetUncatchableException(this.ctx, uncatchable ? 1 : 0);
  }

  newAtom(value: string | number): JSAtom {
    return typeof value === "number" ? this.newAtomUInt32(value) : this.#newAtomString(value);
  }

  newAtomUInt32(value: number): JSAtom {
    assert(
      Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
      "atom value must be a uint32",
    );
    const atom = this.native.JS_NewAtomUInt32(this.ctx, value);
    assert(atom !== QuickJSAtom.NULL, "QuickJS atom did not initialize");
    return new JSAtom(this, atom, true);
  }

  #newAtomString(value: string): JSAtom {
    const bytes = encoder.encode(value);
    const atom = this.native.JS_NewAtomLen(this.ctx, bytes, bytes.length);
    assert(atom !== QuickJSAtom.NULL, "QuickJS atom did not initialize");
    return new JSAtom(this, atom, true);
  }

  getScriptOrModuleName(stackLevels = 0): JSAtom | null {
    assert(
      Number.isSafeInteger(stackLevels) && stackLevels >= 0,
      "stackLevels must be a non-negative safe integer",
    );
    const atom = this.native.JS_GetScriptOrModuleName(this.ctx, stackLevels);
    return atom === QuickJSAtom.NULL ? null : new JSAtom(this, atom, true);
  }

  addIntrinsic(intrinsic: JSIntrinsic): void {
    switch (intrinsic) {
      case "base":
        assert(
          this.native.JS_AddIntrinsicBaseObjects(this.ctx) >= 0,
          "JS_AddIntrinsicBaseObjects failed",
        );
        break;
      case "date":
        assert(this.native.JS_AddIntrinsicDate(this.ctx) >= 0, "JS_AddIntrinsicDate failed");
        break;
      case "eval":
        assert(this.native.JS_AddIntrinsicEval(this.ctx) >= 0, "JS_AddIntrinsicEval failed");
        break;
      case "stringNormalize":
        assert(
          this.native.JS_AddIntrinsicStringNormalize(this.ctx) >= 0,
          "JS_AddIntrinsicStringNormalize failed",
        );
        break;
      case "regexp":
        assert(this.native.JS_AddIntrinsicRegExp(this.ctx) >= 0, "JS_AddIntrinsicRegExp failed");
        break;
      case "regexpCompiler":
        this.native.JS_AddIntrinsicRegExpCompiler(this.ctx);
        break;
      case "json":
        assert(this.native.JS_AddIntrinsicJSON(this.ctx) >= 0, "JS_AddIntrinsicJSON failed");
        break;
      case "proxy":
        assert(this.native.JS_AddIntrinsicProxy(this.ctx) >= 0, "JS_AddIntrinsicProxy failed");
        break;
      case "mapSet":
        assert(this.native.JS_AddIntrinsicMapSet(this.ctx) >= 0, "JS_AddIntrinsicMapSet failed");
        break;
      case "typedArrays":
        assert(
          this.native.JS_AddIntrinsicTypedArrays(this.ctx) >= 0,
          "JS_AddIntrinsicTypedArrays failed",
        );
        break;
      case "promise":
        assert(this.native.JS_AddIntrinsicPromise(this.ctx) >= 0, "JS_AddIntrinsicPromise failed");
        break;
      case "weakRef":
        assert(this.native.JS_AddIntrinsicWeakRef(this.ctx) >= 0, "JS_AddIntrinsicWeakRef failed");
        break;
      default: {
        const neverIntrinsic: any = intrinsic;
        throw new TypeError(`Unknown QuickJS intrinsic: ${neverIntrinsic}`);
      }
    }
  }

  addIntrinsics(intrinsics: JSIntrinsics): void {
    const names =
      intrinsics === "default" ? defaultIntrinsics : intrinsics === "minimal" ? [] : intrinsics;
    for (const intrinsic of names) this.addIntrinsic(intrinsic);
  }

  evalCode(code: string, options: JSEvalOptions = {}): JSValue {
    return this.#eval(code, undefined, options);
  }

  compileCode(code: string, options: JSEvalOptions = {}): JSValue {
    return this.evalCode(code, {
      ...options,
      flags: (options.flags ?? QuickJSEvalFlags.TYPE_GLOBAL) | QuickJSEvalFlags.COMPILE_ONLY,
    });
  }

  evalFunction(value: JSValue): JSValue {
    this.assertSameVM(value);
    const ownedValue = value.dupCell();
    const out = newCell();
    this.#startInterrupt(this.#timeoutMs);
    this.native.qjs_bun_eval_function(this.ctx, out, ptr(ownedValue));
    return this.resultValue(out, this.#endInterrupt());
  }

  evalThis(thisValue: JSValue, code: string, options: JSEvalOptions = {}): JSValue {
    this.assertSameVM(thisValue);
    return this.#eval(code, thisValue, options);
  }

  detectModule(code: string | Uint8Array): boolean {
    const source = typeof code === "string" ? encoder.encode(code) : code;
    return this.native.JS_DetectModule(source, source.length) !== 0;
  }

  parseJson(text: string, options: JSJsonParseOptions = {}): JSValue {
    const source = encoder.encode(text);
    const filename = encoder.encode(`${options.filename ?? "<json>"}\0`);
    const out = newCell();
    if (options.flags === undefined || options.flags === 0) {
      this.native.qjs_bun_parse_json(this.ctx, out, source, source.length, filename);
    } else {
      this.native.qjs_bun_parse_json2(
        this.ctx,
        out,
        source,
        source.length,
        filename,
        options.flags,
      );
    }
    return this.resultValue(out);
  }

  parseJsonExt(text: string, options: JSJsonParseOptions = {}): JSValue {
    return this.parseJson(text, {
      ...options,
      flags: (options.flags ?? 0) | QuickJSParseJsonFlags.EXT,
    });
  }

  readObject(bytes: JSBytes, flags = 0): JSValue {
    const view = bytesView(bytes);
    const out = newCell();
    this.native.qjs_bun_read_object(this.ctx, view, view.byteLength, flags, out);
    return this.resultValue(out);
  }

  jsonStringify(
    value: JSValue,
    replacer: JSValue = this.undefined,
    space: JSValue = this.undefined,
  ): JSValue {
    this.assertSameVM(value, replacer, space);
    const out = newCell();
    this.native.qjs_bun_json_stringify(this.ctx, out, value.ptr, replacer.ptr, space.ptr);
    return this.resultValue(out);
  }

  #eval(code: string, thisValue: JSValue | undefined, options: JSEvalOptions): JSValue {
    const source = encoder.encode(`${code}\0`);
    const filename = encoder.encode(`${options.filename ?? "<eval>"}\0`);
    const flags = options.flags ?? QuickJSEvalFlags.TYPE_GLOBAL;
    const out = newCell();
    this.#startInterrupt(options.timeoutMs ?? this.#timeoutMs);
    if ((flags & QuickJSEvalFlags.TYPE_MASK) === QuickJSEvalFlags.TYPE_MODULE) {
      if (thisValue === undefined) {
        this.native.qjs_bun_eval(
          this.ctx,
          out,
          source,
          source.length - 1,
          filename,
          flags | QuickJSEvalFlags.COMPILE_ONLY,
        );
      } else {
        this.native.qjs_bun_eval_this(
          this.ctx,
          out,
          thisValue.ptr,
          source,
          source.length - 1,
          filename,
          flags | QuickJSEvalFlags.COMPILE_ONLY,
        );
      }
      if (valueTag(ptr(out)) !== QuickJSValueTag.EXCEPTION) {
        if (this.native.qjs_bun_js_module_set_import_meta(this.ctx, ptr(out), 0, 1) < 0) {
          const timedOut = this.#endInterrupt();
          this.native.qjs_bun_free_value(this.ctx, ptr(out));
          throw this.getException(timedOut);
        }
        if ((flags & QuickJSEvalFlags.COMPILE_ONLY) === 0) {
          const result = newCell();
          this.native.qjs_bun_eval_function(this.ctx, result, ptr(out));
          return this.resultValue(result, this.#endInterrupt());
        }
      }
      return this.resultValue(out, this.#endInterrupt());
    }
    if (thisValue === undefined) {
      this.native.qjs_bun_eval(this.ctx, out, source, source.length - 1, filename, flags);
    } else {
      this.native.qjs_bun_eval_this(
        this.ctx,
        out,
        thisValue.ptr,
        source,
        source.length - 1,
        filename,
        flags,
      );
    }
    return this.resultValue(out, this.#endInterrupt());
  }

  callFunction(fn: JSValue, thisValue: JSValue = this.undefined, ...args: JSValue[]): JSValue {
    this.assertSameVM(fn, thisValue, ...args);
    const argv = argvCell(args);
    const out = newCell();
    this.#startInterrupt(this.#timeoutMs);
    this.native.qjs_bun_call(this.ctx, out, fn.ptr, thisValue.ptr, args.length, argv);
    return this.resultValue(out, this.#endInterrupt());
  }

  invoke(thisValue: JSValue, name: string, ...args: JSValue[]): JSValue {
    this.assertSameVM(thisValue, ...args);
    using atom = this.newAtom(name);
    const argv = argvCell(args);
    const out = newCell();
    this.#startInterrupt(this.#timeoutMs);
    this.native.qjs_bun_invoke(this.ctx, out, thisValue.ptr, atom.value, args.length, argv);
    return this.resultValue(out, this.#endInterrupt());
  }

  callConstructor(fn: JSValue, ...args: JSValue[]): JSValue {
    this.assertSameVM(fn, ...args);
    const argv = argvCell(args);
    const out = newCell();
    this.#startInterrupt(this.#timeoutMs);
    this.native.qjs_bun_call_constructor(this.ctx, out, fn.ptr, args.length, argv);
    return this.resultValue(out, this.#endInterrupt());
  }

  callConstructorWithNewTarget(fn: JSValue, newTarget: JSValue, ...args: JSValue[]): JSValue {
    this.assertSameVM(fn, newTarget, ...args);
    const argv = argvCell(args);
    const out = newCell();
    this.#startInterrupt(this.#timeoutMs);
    this.native.qjs_bun_call_constructor2(this.ctx, out, fn.ptr, newTarget.ptr, args.length, argv);
    return this.resultValue(out, this.#endInterrupt());
  }

  get global(): JSValue {
    const out = newCell();
    this.native.qjs_bun_get_global(this.ctx, out);
    return new JSValue(this, out, true);
  }

  newString(value: string): JSValue {
    const bytes = encoder.encode(value);
    const out = newCell();
    this.native.qjs_bun_new_string_len(this.ctx, bytes, bytes.length, out);
    return this.resultValue(out);
  }

  newBoolean(value: boolean): JSValue {
    const out = newCell();
    this.native.qjs_bun_new_bool(this.ctx, value ? 1 : 0, out);
    return this.resultValue(out);
  }

  newNumber(value: number): JSValue {
    return new JSValue(this, writeNumber(value), false);
  }

  newInt32(value: number): JSValue {
    assert(
      Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff,
      "value must be an int32",
    );
    const out = newCell();
    this.native.qjs_bun_new_int32(this.ctx, value, out);
    return this.resultValue(out);
  }

  newInt64(value: number | bigint): JSValue {
    if (typeof value === "number")
      assert(Number.isSafeInteger(value), "value must be a safe integer");
    const int = BigInt(value);
    assert(int >= MIN_INT64 && int <= MAX_INT64, "value must be an int64");
    const out = newCell();
    this.native.qjs_bun_new_int64(this.ctx, int, out);
    return this.resultValue(out);
  }

  newUint32(value: number): JSValue {
    assert(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, "value must be a uint32");
    const out = newCell();
    this.native.qjs_bun_new_uint32(this.ctx, value | 0, out);
    return this.resultValue(out);
  }

  newFloat64(value: number): JSValue {
    const out = newCell();
    this.native.qjs_bun_new_float64(this.ctx, value, out);
    return this.resultValue(out);
  }

  newCatchOffset(value: number): JSValue {
    assert(
      Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff,
      "value must be an int32",
    );
    const out = newCell();
    this.native.qjs_bun_new_catch_offset(this.ctx, value, out);
    return this.resultValue(out);
  }

  newBigInt(value: bigint): JSValue {
    const out = newCell();
    if (value >= MIN_INT64 && value <= MAX_INT64) {
      this.native.qjs_bun_new_bigint64(this.ctx, value, out);
      return this.resultValue(out);
    }
    if (value >= 0n && value <= MAX_UINT64) {
      this.native.qjs_bun_new_biguint64(this.ctx, value, out);
      return this.resultValue(out);
    }
    return this.evalCode(`${value.toString()}n`);
  }

  newAtomString(value: string): JSValue {
    const out = newCell();
    this.native.qjs_bun_new_atom_string(this.ctx, encoder.encode(`${value}\0`), out);
    return this.resultValue(out);
  }

  newObject(): JSValue {
    const out = newCell();
    this.native.qjs_bun_new_object(this.ctx, out);
    return this.resultValue(out);
  }

  newObjectProto(prototype: JSValue): JSValue {
    this.assertSameVM(prototype);
    const out = newCell();
    this.native.qjs_bun_new_object_proto(this.ctx, prototype.ptr, out);
    return this.resultValue(out);
  }

  newObjectClass(classId: number): JSValue {
    assert(
      Number.isSafeInteger(classId) && classId >= 0,
      "classId must be a non-negative safe integer",
    );
    const out = newCell();
    this.native.qjs_bun_new_object_class(this.ctx, classId, out);
    return this.resultValue(out);
  }

  newObjectProtoClass(prototype: JSValue, classId: number): JSValue {
    this.assertSameVM(prototype);
    assert(
      Number.isSafeInteger(classId) && classId >= 0,
      "classId must be a non-negative safe integer",
    );
    const out = newCell();
    this.native.qjs_bun_new_object_proto_class(this.ctx, prototype.ptr, classId, out);
    return this.resultValue(out);
  }

  getClassProto(classId: number): JSValue {
    assert(
      Number.isSafeInteger(classId) && classId >= 0,
      "classId must be a non-negative safe integer",
    );
    const out = newCell();
    this.native.qjs_bun_get_class_proto(this.ctx, classId, out);
    return this.resultValue(out);
  }

  setClassProto(classId: number, prototype: JSValue): void {
    this.assertSameVM(prototype);
    assert(
      Number.isSafeInteger(classId) && classId >= 0,
      "classId must be a non-negative safe integer",
    );
    this.native.qjs_bun_set_class_proto(this.ctx, classId, prototype.ptr);
  }

  newArray(): JSValue {
    const out = newCell();
    this.native.qjs_bun_new_array(this.ctx, out);
    return this.resultValue(out);
  }

  newDate(value: Date | number): JSValue {
    const epochMs = value instanceof Date ? value.getTime() : value;
    assert(Number.isFinite(epochMs), "QuickJS date epoch milliseconds must be finite");
    const epoch = new Float64Array([epochMs]);
    const out = newCell();
    this.native.qjs_bun_new_date(this.ctx, epoch, out);
    return this.resultValue(out);
  }

  newArrayBufferCopy(bytes: JSBytes): JSValue {
    const view = bytesView(bytes);
    const out = newCell();
    this.native.qjs_bun_new_array_buffer_copy(this.ctx, out, view, view.byteLength);
    return this.resultValue(out);
  }

  newTypedArray(type: JSTypedArrayType, ...args: JSValue[]): JSValue {
    this.assertSameVM(...args);
    const argv = argvCell(args);
    const out = newCell();
    this.native.qjs_bun_new_typed_array(this.ctx, out, args.length, argv, type);
    return this.resultValue(out);
  }

  newError(error: Error): JSValue {
    const out = newCell();
    this.native.qjs_bun_new_error(this.ctx, out);
    using handle = this.resultValue(out);
    using name = this.newString(error.name);
    using message = this.newString(error.message);
    handle.defineProp("name", name);
    handle.defineProp("message", message);
    return handle.dup();
  }

  newFunction(fn: HostFunction): JSValue {
    const context = this.ctx;
    const callback = this.#hostCallback.ptr;
    assert(callback !== null, "Host callback pointer is null");
    const id = this.#allocateHostSlot(fn);
    const out = newCell();
    try {
      this.native.qjs_bun_new_host_function(context, callback, id, out);
      return this.resultValue(out);
    } catch (error) {
      this.#releaseHostSlot(id);
      throw error;
    }
  }

  enqueueJob(fn: HostFunction, ...args: JSValue[]): void {
    this.assertSameVM(...args);
    const callback = this.#hostCallback.ptr;
    assert(callback !== null, "Host callback pointer is null");
    const id = this.#allocateHostSlot(fn);
    const argv = argvCell(args);
    if (this.native.qjs_bun_enqueue_host_job(this.ctx, callback, id, args.length, argv) < 0) {
      this.#releaseHostSlot(id);
      throw this.getException();
    }
  }

  freeHostSlot(hostId: number): void {
    if (this.#disposed) return;
    if (this.#hosts[hostId] === undefined) return;
    this.#releaseHostSlot(hostId);
  }

  #allocateHostSlot(fn: HostFunction): number {
    const recycled = this.#freeHostSlots.pop();
    if (recycled !== undefined) {
      this.#hosts[recycled] = fn;
      return recycled;
    }
    const id = this.#hosts.length;
    assert(id <= MAX_HOST_FUNCTION_ID, "Too many QuickJS host functions");
    this.#hosts.push(fn);
    return id;
  }

  #releaseHostSlot(id: number): void {
    this.#hosts[id] = undefined;
    this.#freeHostSlots.push(id);
  }

  newPromise(): Deferred {
    const promise = newCell();
    const resolving = new Uint8Array(VALUE_CELL_BYTES * 2);
    this.native.qjs_bun_new_promise(this.ctx, resolving, promise);
    const promiseValue = this.resultValue(promise);
    const resolve = resolving.subarray(0, VALUE_CELL_BYTES);
    const reject = resolving.subarray(VALUE_CELL_BYTES);
    return new Deferred(
      promiseValue,
      new JSValue(this, resolve, true),
      new JSValue(this, reject, true),
    );
  }

  newCModule(name: string, init: JSModuleInit): JSModule {
    let module: JSModule | undefined;
    const callback = new JSCallback(
      (context: Pointer, _modulePointer: Pointer) => {
        try {
          assert(module !== undefined, "QuickJS module is not initialized");
          init(module);
          return 0;
        } catch (error) {
          throwQuickJSError(
            this.native,
            context,
            "internal",
            error instanceof Error ? error.message : String(error),
          );
          return -1;
        }
      },
      {
        args: ["ptr", "ptr"],
        returns: "i32",
      },
    );
    assert(callback.ptr !== null, "Module init callback pointer is null");
    const modulePointer = this.native.JS_NewCModule(
      this.ctx,
      encoder.encode(`${name}\0`),
      callback.ptr,
    ) as Pointer | null;
    if (modulePointer === null) {
      callback.close();
      throw this.getException();
    }
    module = new JSModule(this, modulePointer);
    this.#moduleCallbacks.push(callback);
    return module;
  }

  newValue(value: unknown): JSValue {
    if (value instanceof JSValue) {
      this.assertSameVM(value);
      return value.dup();
    }
    if (value === undefined) return this.undefined;
    if (value === null) return this.null;
    if (typeof value === "boolean") return value ? this.true : this.false;
    if (typeof value === "number") return this.newNumber(value);
    if (typeof value === "string") return this.newString(value);
    if (typeof value === "bigint") return this.newBigInt(value);
    if (value instanceof Error) return this.newError(value);
    if (value instanceof Promise) {
      throw new TypeError("Convert host promises explicitly with newPromise()");
    }
    if (Array.isArray(value)) {
      using array = this.newArray();
      for (let index = 0; index < value.length; index++) {
        using handle = this.newValue(value[index]);
        array.setIndex(index, handle);
      }
      return array.dup();
    }
    if (typeof value === "object" && value !== null) {
      const prototype = Object.getPrototypeOf(value);
      assert(
        prototype === Object.prototype || prototype === null,
        "Only plain objects can be converted to QuickJS",
      );
      using object = this.newObject();
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        assert(
          descriptor !== undefined && "value" in descriptor,
          "Only data properties can be converted to QuickJS",
        );
        using handle = this.newValue(descriptor.value);
        object.defineProp(key, handle);
      }
      return object.dup();
    }
    throw new TypeError(`Cannot convert host ${typeof value} to QuickJS`);
  }

  dump(handle: JSValue): unknown {
    this.assertSameVM(handle);
    let ended = false;
    this.#startInterrupt(this.#timeoutMs);
    try {
      return handle.dump();
    } catch (error) {
      const timedOut = this.#endInterrupt();
      ended = true;
      if (!timedOut) throw error;
      if (error instanceof JSException) error.dispose();
      throw this.#timeoutException();
    } finally {
      if (!ended) this.#endInterrupt();
    }
  }

  setGlobal(name: string, value: JSValue): void {
    this.assertSameVM(value);
    using global = this.global;
    global.defineProp(name, value);
  }

  getGlobal(name: string): JSValue {
    using global = this.global;
    return global.getProp(name);
  }

  resolveModule(module: JSValue): void {
    this.assertSameVM(module);
    if (this.native.qjs_bun_resolve_module(this.ctx, module.ptr) < 0) throw this.getException();
  }

  loadModule(basename: string, filename: string): JSValue {
    const out = newCell();
    this.native.qjs_bun_load_module(
      this.ctx,
      out,
      encoder.encode(`${basename}\0`),
      encoder.encode(`${filename}\0`),
    );
    return this.resultValue(out);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.runtime.unregisterContext(this);
    this.native.JS_FreeContext(this.#context);
    this.#hostCallback.close();
    for (const callback of this.#moduleCallbacks) callback.close();
    this.#moduleCallbacks.length = 0;
    this.#hosts.length = 0;
    this.#disposed = true;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #timeoutException(): JSException {
    using handle = this.newError(new Error("QuickJS execution timed out"));
    using name = this.newString("TimeoutError");
    handle.defineProp("name", name);
    return new JSException(handle.dup());
  }

  #callHost(request: Pointer): void {
    const hostId = read.u32(request, HOST_REQUEST_HOST_ID_OFFSET);
    const host = this.#hosts[hostId];
    const argc = read.u32(request, HOST_REQUEST_ARGC_OFFSET);
    const thisHandle = new JSValue(
      this,
      new Uint8Array(toArrayBuffer(request, HOST_REQUEST_THIS_OFFSET, VALUE_CELL_BYTES)),
      false,
    );
    try {
      assert(host !== undefined, "Unknown QuickJS host function");
      let result: HostValue | void;
      if (argc === 0) {
        result = host.call(thisHandle);
      } else {
        const argv = read.ptr(request, HOST_REQUEST_ARGV_OFFSET) as Pointer | null;
        assert(argv !== null, "Host argv pointer is null");
        const args = Array.from<JSValue>({ length: argc });
        for (let index = 0; index < argc; index++) {
          args[index] = new JSValue(
            this,
            new Uint8Array(toArrayBuffer(argv, index * VALUE_CELL_BYTES, VALUE_CELL_BYTES)),
            false,
          );
        }
        result = host.call(thisHandle, ...args);
      }
      if (result instanceof JSValue) {
        this.assertSameVM(result);
        this.#finishHostRequest(request, result, false);
        result.dispose();
      } else {
        using handle = this.newValue(result);
        this.#finishHostRequest(request, handle, false);
      }
    } catch (error) {
      using handle = this.newError(error instanceof Error ? error : new Error(String(error)));
      this.#finishHostRequest(request, handle, true);
    }
  }

  #finishHostRequest(request: Pointer, handle: JSValue, throwValue: boolean): void {
    const out = new Uint8Array(toArrayBuffer(request, HOST_REQUEST_OUT_OFFSET, VALUE_CELL_BYTES));
    if (throwValue) {
      const thrown = handle.dupCell();
      this.native.qjs_bun_throw(this.ctx, ptr(thrown), out);
    } else if (valueTag(handle.ptr) >= 0) {
      out.set(handle.cell);
    } else {
      this.native.qjs_bun_dup_value(this.ctx, handle.ptr, out);
    }
  }

  #startInterrupt(timeoutMs: number): void {
    this.runtime.startInterrupt(timeoutMs);
  }

  #endInterrupt(): boolean {
    return this.runtime.endInterrupt();
  }
}
