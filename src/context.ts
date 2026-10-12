import assert from "node:assert/strict";
import { JSCallback, read, type Pointer } from "bun:ffi";
import {
  bytes,
  cstring,
  encoder,
  QuickJSAtom,
  QuickJSEvalFlags,
  QuickJSParseJsonFlags,
  QuickJSValueTag,
  type QuickJS,
  type QuickJSNative,
} from "./ffi";
import type { JSRuntime } from "./runtime";
import type {
  HostFunction,
  JSBytes,
  JSContextOptions,
  JSDumpOptions,
  JSEvalOptions,
  JSIntrinsic,
  JSIntrinsics,
  JSJsonParseOptions,
  JSModuleInit,
  JSTypedArrayType,
} from "./types";
import { Deferred, JSAtom, JSException, JSModule, JSValue } from "./value";

const intrinsics: readonly JSIntrinsic[] = [
  "base",
  "date",
  "eval",
  "stringNormalize",
  "regexp",
  "regexpCompiler",
  "json",
  "proxy",
  "mapSet",
  "typedArrays",
  "promise",
  "weakRef",
];

const cell = new Uint8Array(16);
const cellInt32 = new Int32Array(cell.buffer);
const cellFloat64 = new Float64Array(cell.buffer);

function primitive(tag: number, value: number): Uint8Array {
  if (tag === QuickJSValueTag.FLOAT64) cellFloat64[0] = value;
  else {
    cellInt32[0] = value;
    cellInt32[1] = 0;
  }
  cellInt32[2] = tag;
  cellInt32[3] = 0;
  return cell.slice();
}

function argv(args: readonly JSValue[]): Uint8Array | null {
  if (args.length === 0) return null;
  const cells = new Uint8Array(16 * args.length);
  for (let index = 0; index < args.length; index++) cells.set(args[index]!.cell, index * 16);
  return cells;
}

function isJson(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || depth >= 1024) return false;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return false;
    for (const item of value) if (!isJson(item, depth + 1)) return false;
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || !isJson(descriptor.value, depth + 1)) return false;
  }
  return true;
}

export class JSContext {
  readonly library: QuickJS;
  readonly native: QuickJSNative;
  readonly runtime: JSRuntime;
  readonly undefined: JSValue;
  readonly null: JSValue;
  readonly true: JSValue;
  readonly false: JSValue;
  readonly handles: JSValue[] = [];
  scratch = Buffer.allocUnsafe(4096);

  #context: Pointer;
  #disposed = false;
  #timeoutMs: number;
  #atoms = new Map<string, number>();

  constructor(runtime: JSRuntime, options: JSContextOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 1000;
    assert(Number.isFinite(this.#timeoutMs) && this.#timeoutMs > 0, "timeoutMs must be positive");
    this.runtime = runtime;
    this.library = runtime.library;
    this.native = runtime.native;

    const raw = options.intrinsics !== undefined && options.intrinsics !== "default";
    const context = this.native.qjs_bun_new_context(runtime.ptr, raw ? 1 : 0, this.#timeoutMs);
    assert(typeof context === "number", "QuickJS context did not initialize");
    this.#context = context;
    runtime.contexts.set(context, this);

    this.undefined = new JSValue(this, primitive(QuickJSValueTag.UNDEFINED, 0), false);
    this.null = new JSValue(this, primitive(QuickJSValueTag.NULL, 0), false);
    this.true = new JSValue(this, primitive(QuickJSValueTag.BOOL, 1), false);
    this.false = new JSValue(this, primitive(QuickJSValueTag.BOOL, 0), false);

    if (raw) {
      try {
        this.addIntrinsics(options.intrinsics!);
      } catch (error) {
        this.dispose();
        throw error;
      }
    }
  }

  get ptr(): Pointer {
    return this.ctx;
  }

  get ctx(): Pointer {
    assert(!this.#disposed, "QuickJS context is disposed");
    return this.#context;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get global(): JSValue {
    const out = new Uint8Array(16);
    this.native.qjs_bun_get_global(this.ctx, out);
    return new JSValue(this, out, true);
  }

  getOpaque(): Pointer | null {
    const opaque = this.native.JS_GetContextOpaque(this.ctx);
    return typeof opaque === "number" ? opaque : null;
  }

  setOpaque(opaque: Pointer | null): void {
    this.native.JS_SetContextOpaque(this.ctx, opaque);
  }

  assertSameVM(...values: JSValue[]): void {
    for (const value of values) assert(value.vm === this, "JSValue belongs to another VM");
  }

  hasException(): boolean {
    return this.native.JS_HasException(this.ctx) !== 0;
  }

  getException(): JSException {
    const out = new Uint8Array(16);
    this.native.qjs_bun_get_exception(this.ctx, out);
    return new JSException(new JSValue(this, out, true));
  }

  resultValue(cell: Uint8Array): JSValue {
    const value = new JSValue(this, cell, true);
    if (value.tag !== QuickJSValueTag.EXCEPTION) return value;
    throw this.getException();
  }

  setUncatchableException(uncatchable: boolean): void {
    this.native.JS_SetUncatchableException(this.ctx, uncatchable ? 1 : 0);
  }

  atom(key: string | number | JSAtom): number {
    if (typeof key === "number") {
      if (Number.isInteger(key) && key >= 0 && key <= QuickJSAtom.MAX_INT) {
        return (key | QuickJSAtom.TAG_INT) >>> 0;
      }
      key = String(key);
    } else if (key instanceof JSAtom) {
      return key.value;
    }
    let atom = this.#atoms.get(key);
    if (atom === undefined) {
      if (this.#atoms.size >= 4096 && this.runtime.hostDepth === 0) {
        for (const cached of this.#atoms.values()) this.native.JS_FreeAtom(this.ctx, cached);
        this.#atoms.clear();
      }
      const text = encoder.encode(key);
      atom = key.isWellFormed()
        ? this.native.JS_NewAtomLen(this.ctx, text, text.length)
        : this.newAtom(key).value;
      assert(atom !== QuickJSAtom.NULL, "QuickJS atom did not initialize");
      this.#atoms.set(key, atom);
    }
    return atom;
  }

  newAtom(value: string | number): JSAtom {
    if (typeof value === "number") return this.newAtomUInt32(value);
    if (!value.isWellFormed()) {
      using text = this.newString(value);
      return text.toAtom();
    }
    const text = encoder.encode(value);
    const atom = this.native.JS_NewAtomLen(this.ctx, text, text.length);
    assert(atom !== QuickJSAtom.NULL, "QuickJS atom did not initialize");
    return new JSAtom(this, atom, true);
  }

  newAtomUInt32(value: number): JSAtom {
    assert(
      Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
      "atom value must be a uint32",
    );
    const atom = this.native.JS_NewAtomUInt32(this.ctx, value);
    assert(atom !== QuickJSAtom.NULL, "QuickJS atom did not initialize");
    return new JSAtom(this, atom, true);
  }

  getScriptOrModuleName(stackLevels = 0): JSAtom | null {
    assert(
      Number.isInteger(stackLevels) && stackLevels >= 0,
      "stackLevels must be a non-negative safe integer",
    );
    const atom = this.native.JS_GetScriptOrModuleName(this.ctx, stackLevels);
    return atom === QuickJSAtom.NULL ? null : new JSAtom(this, atom, true);
  }

  addIntrinsic(intrinsic: JSIntrinsic): void {
    const index = intrinsics.indexOf(intrinsic);
    assert(index >= 0, `Unknown QuickJS intrinsic: ${intrinsic}`);
    assert(
      this.native.qjs_bun_add_intrinsic(this.ctx, index) >= 0,
      `QuickJS could not add the ${intrinsic} intrinsic`,
    );
  }

  addIntrinsics(names: JSIntrinsics): void {
    const list =
      names === "default"
        ? intrinsics.filter((intrinsic) => intrinsic !== "regexpCompiler")
        : names === "minimal"
          ? []
          : names;
    for (const intrinsic of list) this.addIntrinsic(intrinsic);
  }

  evalCode(code: string, options: JSEvalOptions = {}): JSValue {
    return this.#eval(code, null, options);
  }

  evalThis(thisValue: JSValue, code: string, options: JSEvalOptions = {}): JSValue {
    this.assertSameVM(thisValue);
    return this.#eval(code, thisValue.ptr, options);
  }

  compileCode(code: string, options: JSEvalOptions = {}): JSValue {
    return this.evalCode(code, {
      ...options,
      flags: (options.flags ?? QuickJSEvalFlags.TYPE_GLOBAL) | QuickJSEvalFlags.COMPILE_ONLY,
    });
  }

  evalFunction(value: JSValue): JSValue {
    this.assertSameVM(value);
    const out = new Uint8Array(16);
    this.native.qjs_bun_eval_function(this.ctx, out, value.ptr, this.#timeoutMs);
    return this.resultValue(out);
  }

  detectModule(code: string | Uint8Array): boolean {
    const source =
      typeof code === "string"
        ? encoder.encode(`${code}\0`)
        : Buffer.concat([code, Buffer.from([0])]);
    return this.native.JS_DetectModule(source, source.length - 1) !== 0;
  }

  parseJson(text: string, options: JSJsonParseOptions = {}): JSValue {
    const source = encoder.encode(`${text}\0`);
    const out = new Uint8Array(16);
    this.native.qjs_bun_parse_json(
      this.ctx,
      out,
      source,
      source.length - 1,
      cstring(options.filename ?? "<json>"),
      options.flags ?? 0,
    );
    return this.resultValue(out);
  }

  parseJsonExt(text: string, options: JSJsonParseOptions = {}): JSValue {
    return this.parseJson(text, {
      ...options,
      flags: (options.flags ?? 0) | QuickJSParseJsonFlags.EXT,
    });
  }

  readObject(data: JSBytes, flags = 0): JSValue {
    const view = bytes(data);
    const out = new Uint8Array(16);
    this.native.qjs_bun_read_object(this.ctx, out, view, view.byteLength, flags);
    return this.resultValue(out);
  }

  jsonStringify(
    value: JSValue,
    replacer: JSValue = this.undefined,
    space: JSValue = this.undefined,
  ): JSValue {
    this.assertSameVM(value, replacer, space);
    const out = new Uint8Array(16);
    this.native.qjs_bun_json_stringify(this.ctx, out, value.ptr, replacer.ptr, space.ptr);
    return this.resultValue(out);
  }

  callFunction(fn: JSValue, thisValue: JSValue = this.undefined, ...args: JSValue[]): JSValue {
    this.assertSameVM(fn, thisValue, ...args);
    const out = new Uint8Array(16);
    this.native.qjs_bun_call(
      this.ctx,
      out,
      fn.ptr,
      thisValue.ptr,
      args.length,
      argv(args),
      this.#timeoutMs,
    );
    return this.resultValue(out);
  }

  invoke(thisValue: JSValue, name: string | number | JSAtom, ...args: JSValue[]): JSValue {
    this.assertSameVM(thisValue, ...args);
    const out = new Uint8Array(16);
    this.native.qjs_bun_invoke(
      this.ctx,
      out,
      thisValue.ptr,
      this.atom(name),
      args.length,
      argv(args),
      this.#timeoutMs,
    );
    return this.resultValue(out);
  }

  callConstructor(fn: JSValue, ...args: JSValue[]): JSValue {
    this.assertSameVM(fn, ...args);
    const out = new Uint8Array(16);
    this.native.qjs_bun_call_constructor(
      this.ctx,
      out,
      fn.ptr,
      null,
      args.length,
      argv(args),
      this.#timeoutMs,
    );
    return this.resultValue(out);
  }

  callConstructorWithNewTarget(fn: JSValue, newTarget: JSValue, ...args: JSValue[]): JSValue {
    this.assertSameVM(fn, newTarget, ...args);
    const out = new Uint8Array(16);
    this.native.qjs_bun_call_constructor(
      this.ctx,
      out,
      fn.ptr,
      newTarget.ptr,
      args.length,
      argv(args),
      this.#timeoutMs,
    );
    return this.resultValue(out);
  }

  newString(value: string): JSValue {
    if (!value.isWellFormed()) return this.parseJson(JSON.stringify(value));
    const text = encoder.encode(value);
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_string_len(this.ctx, out, text, text.length);
    return this.resultValue(out);
  }

  newBoolean(value: boolean): JSValue {
    return value ? this.true : this.false;
  }

  newNumber(value: number): JSValue {
    if (Number.isInteger(value) && Object.is(value, value | 0)) {
      return new JSValue(this, primitive(QuickJSValueTag.INT, value), false);
    }
    return new JSValue(this, primitive(QuickJSValueTag.FLOAT64, value), false);
  }

  newInt32(value: number): JSValue {
    assert(Number.isInteger(value) && Object.is(value, value | 0), "value must be an int32");
    return this.newNumber(value);
  }

  newUint32(value: number): JSValue {
    assert(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, "value must be a uint32");
    return this.newNumber(value);
  }

  newInt64(value: number | bigint): JSValue {
    const int = BigInt(value);
    assert(int >= -(1n << 63n) && int <= (1n << 63n) - 1n, "value must be an int64");
    return this.newNumber(Number(int));
  }

  newFloat64(value: number): JSValue {
    return this.newNumber(value);
  }

  newBigInt(value: bigint): JSValue {
    const out = new Uint8Array(16);
    if (value >= -(1n << 63n) && value <= (1n << 63n) - 1n) {
      this.native.qjs_bun_new_bigint64(this.ctx, out, value);
    } else if (value >= -(1n << 127n) && value <= (1n << 127n) - 1n) {
      const low = BigInt.asUintN(64, value);
      const high = BigInt.asUintN(64, value >> 64n);
      this.native.qjs_bun_new_bigint128(this.ctx, out, low, high);
    } else {
      return this.evalCode(`${value}n`);
    }
    return this.resultValue(out);
  }

  newAtomString(value: string): JSValue {
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_atom_string(this.ctx, out, cstring(value));
    return this.resultValue(out);
  }

  newSymbol(description: string, global = false): JSValue {
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_symbol(this.ctx, out, cstring(description), global ? 1 : 0);
    return this.resultValue(out);
  }

  newObject(): JSValue {
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_object(this.ctx, out);
    return this.resultValue(out);
  }

  newObjectProto(prototype: JSValue): JSValue {
    this.assertSameVM(prototype);
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_object_proto(this.ctx, out, prototype.ptr);
    return this.resultValue(out);
  }

  newObjectClass(classId: number): JSValue {
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_object_class(this.ctx, out, classId);
    return this.resultValue(out);
  }

  newObjectProtoClass(prototype: JSValue, classId: number): JSValue {
    this.assertSameVM(prototype);
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_object_proto_class(this.ctx, out, prototype.ptr, classId);
    return this.resultValue(out);
  }

  getClassProto(classId: number): JSValue {
    const out = new Uint8Array(16);
    this.native.qjs_bun_get_class_proto(this.ctx, out, classId);
    return this.resultValue(out);
  }

  setClassProto(classId: number, prototype: JSValue): void {
    this.assertSameVM(prototype);
    this.native.qjs_bun_set_class_proto(this.ctx, classId, prototype.ptr);
  }

  newArray(): JSValue {
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_array(this.ctx, out);
    return this.resultValue(out);
  }

  newDate(value: Date | number): JSValue {
    const epochMs = value instanceof Date ? value.getTime() : value;
    assert(Number.isFinite(epochMs), "QuickJS date epoch milliseconds must be finite");
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_date(this.ctx, out, epochMs);
    return this.resultValue(out);
  }

  newArrayBuffer(data: JSBytes): JSValue {
    const view = bytes(data);
    if (view.byteLength === 0) return this.newArrayBufferCopy(view);
    const id = this.runtime.slot(view);
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_array_buffer(
      this.ctx,
      out,
      view,
      view.byteLength,
      this.runtime.hostCallback,
      id,
    );
    try {
      return this.resultValue(out);
    } catch (error) {
      this.runtime.release(id);
      throw error;
    }
  }

  newArrayBufferCopy(data: JSBytes): JSValue {
    const view = bytes(data);
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_array_buffer_copy(this.ctx, out, view, view.byteLength);
    return this.resultValue(out);
  }

  newTypedArray(type: JSTypedArrayType, ...args: JSValue[]): JSValue {
    this.assertSameVM(...args);
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_typed_array(this.ctx, out, args.length, argv(args), type);
    return this.resultValue(out);
  }

  newError(error: Error): JSValue {
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_error(this.ctx, out);
    const handle = this.resultValue(out);
    try {
      using name = this.newString(error.name);
      using message = this.newString(error.message);
      handle.defineProp("name", name);
      handle.defineProp("message", message);
      return handle;
    } catch (failure) {
      handle.dispose();
      throw failure;
    }
  }

  newFunction(fn: HostFunction): JSValue {
    const id = this.runtime.slot(fn);
    const out = new Uint8Array(16);
    this.native.qjs_bun_new_host_function(this.ctx, out, this.runtime.hostCallback, id);
    try {
      return this.resultValue(out);
    } catch (error) {
      this.runtime.release(id);
      throw error;
    }
  }

  enqueueJob(fn: HostFunction, ...args: JSValue[]): void {
    this.assertSameVM(...args);
    using handle = this.newFunction(fn);
    if (this.native.qjs_bun_enqueue_job(this.ctx, args.length + 1, argv([handle, ...args])) < 0) {
      throw this.getException();
    }
  }

  newPromise(): Deferred {
    const promise = new Uint8Array(16);
    const resolving = new Uint8Array(32);
    this.native.qjs_bun_new_promise(this.ctx, promise, resolving);
    return new Deferred(
      this.resultValue(promise),
      new JSValue(this, resolving.slice(0, 16), true),
      new JSValue(this, resolving.slice(16, 32), true),
    );
  }

  newCModule(name: string, init: JSModuleInit): JSModule {
    let module: JSModule | undefined;
    const callback = new JSCallback(
      (context: Pointer) => {
        this.runtime.hostDepth++;
        try {
          init(module!);
          return 0;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.native.qjs_bun_throw_error(context, 4, cstring(message));
          return -1;
        } finally {
          this.runtime.hostDepth--;
        }
      },
      { args: ["ptr", "ptr"], returns: "i32" },
    );
    const pointer = this.native.JS_NewCModule(this.ctx, cstring(name), callback.ptr);
    if (typeof pointer !== "number") {
      callback.close();
      throw this.getException();
    }
    this.runtime.callbacks.push(callback);
    module = new JSModule(this, pointer);
    return module;
  }

  newValue(value: unknown): JSValue {
    if (
      typeof value === "object" &&
      value !== null &&
      !(value instanceof JSValue) &&
      isJson(value, 0)
    ) {
      return this.parseJson(JSON.stringify(value));
    }
    return this.#newValue(value, 0);
  }

  dump(handle: JSValue, options: JSDumpOptions = {}): unknown {
    this.assertSameVM(handle);
    const maxDepth = options.maxDepth ?? 1024;
    const maxNodes = options.maxNodes ?? 1_000_000;
    assert(Number.isSafeInteger(maxDepth) && maxDepth > 0, "maxDepth must be a positive integer");
    assert(Number.isSafeInteger(maxNodes) && maxNodes > 0, "maxNodes must be a positive integer");
    const seen = new Map<number, unknown>();
    let nodes = 0;
    const visit = (value: JSValue, depth: number): unknown => {
      if (depth > maxDepth)
        throw new RangeError(`QuickJS dump exceeded maximum depth of ${maxDepth}`);
      if (++nodes > maxNodes)
        throw new RangeError(`QuickJS dump exceeded maximum of ${maxNodes} values`);
      const type = value.type;
      switch (type) {
        case "undefined":
          return undefined;
        case "null":
          return null;
        case "boolean":
          return value.toBoolean();
        case "number":
          return value.toNumber();
        case "bigint":
          return value.toBigInt();
        case "string":
          return value.toString();
        case "error":
          return value.toError();
        case "array":
        case "object": {
          const pointer = read.ptr(value.ptr);
          const existing = seen.get(pointer);
          if (existing !== undefined) return existing;
          if (type === "array") {
            const array: unknown[] = [];
            seen.set(pointer, array);
            const length = value.length;
            for (let index = 0; index < length; index++) {
              using entry = value.getIndex(index);
              array.push(visit(entry, depth + 1));
            }
            return array;
          }
          const object: Record<string, unknown> = {};
          seen.set(pointer, object);
          for (const key of value.keys()) {
            using entry = value.getProp(key);
            Object.defineProperty(object, key, {
              value: visit(entry, depth + 1),
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
          return object;
        }
        default:
          throw new TypeError(`Cannot dump QuickJS ${type}`);
      }
    };
    const scope = new Float64Array(2);
    let left = false;
    this.native.qjs_bun_enter_scope(this.runtime.ptr, this.#timeoutMs, scope);
    try {
      return visit(handle, 0);
    } catch (error) {
      left = true;
      if (!this.native.qjs_bun_leave_scope(this.runtime.ptr, scope)) throw error;
      if (error instanceof JSException) error.dispose();
      const out = new Uint8Array(16);
      this.native.qjs_bun_timeout_error(this.ctx, out);
      throw new JSException(this.resultValue(out));
    } finally {
      if (!left) this.native.qjs_bun_leave_scope(this.runtime.ptr, scope);
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
    const out = new Uint8Array(16);
    this.native.qjs_bun_load_module(this.ctx, out, cstring(basename), cstring(filename));
    return this.resultValue(out);
  }

  dispose(): void {
    if (this.#disposed) return;
    while (this.handles.length > 0) this.handles[this.handles.length - 1]!.dispose();
    for (const atom of this.#atoms.values()) this.native.JS_FreeAtom(this.#context, atom);
    this.#atoms.clear();
    this.#disposed = true;
    this.runtime.contexts.delete(this.#context);
    this.native.qjs_bun_free_context(this.#context);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #eval(code: string, thisValue: Pointer | null, options: JSEvalOptions): JSValue {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeoutMs must be positive");
    const source = encoder.encode(`${code}\0`);
    const out = new Uint8Array(16);
    this.native.qjs_bun_eval(
      this.ctx,
      out,
      thisValue,
      source,
      source.length - 1,
      cstring(options.filename ?? "<eval>"),
      options.flags ?? QuickJSEvalFlags.TYPE_GLOBAL,
      timeoutMs,
    );
    return this.resultValue(out);
  }

  #newValue(value: unknown, depth: number): JSValue {
    if (value instanceof JSValue) {
      this.assertSameVM(value);
      return value.dup();
    }
    if (value === undefined) return this.undefined;
    if (value === null) return this.null;
    switch (typeof value) {
      case "boolean":
        return value ? this.true : this.false;
      case "number":
        return this.newNumber(value);
      case "string":
        return this.newString(value);
      case "bigint":
        return this.newBigInt(value);
    }
    if (value instanceof Error) return this.newError(value);
    if (value instanceof Promise) {
      throw new TypeError("Convert host promises explicitly with newPromise()");
    }
    if (typeof value !== "object")
      throw new TypeError(`Cannot convert host ${typeof value} to QuickJS`);
    assert(depth < 1024, "Cannot convert host value nested deeper than 1024");
    if (Array.isArray(value)) {
      const array = this.newArray();
      try {
        for (let index = 0; index < value.length; index++) {
          using item = this.#newValue(value[index], depth + 1);
          array.defineIndex(index, item);
        }
        return array;
      } catch (error) {
        array.dispose();
        throw error;
      }
    }
    const prototype = Object.getPrototypeOf(value);
    assert(
      prototype === Object.prototype || prototype === null,
      "Only plain objects can be converted to QuickJS",
    );
    const object = this.newObject();
    try {
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        assert(
          descriptor !== undefined && "value" in descriptor,
          "Only data properties can be converted to QuickJS",
        );
        using item = this.#newValue(descriptor.value, depth + 1);
        object.defineProp(key, item);
      }
      return object;
    } catch (error) {
      object.dispose();
      throw error;
    }
  }
}
