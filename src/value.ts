import { CString, JSCallback, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import assert from "node:assert/strict";
import { JSAtom } from "./atom";
import type { JSContext } from "./context";
import {
  QuickJSAtom,
  QuickJSGetOwnPropertyNamesFlags,
  QuickJSPromiseState,
  QuickJSPropertyFlags,
  QuickJSValueTag,
  type QuickJSPromiseStateValue,
} from "./ffi";
import { newCell, optionalUint32, readCString, valueTag } from "./internal";
import type { HostValue, JSValueType, JSOpaque, JSPrintOptions, JSTypedArrayInfo } from "./types";

export class JSValue {
  #disposed = false;

  constructor(
    readonly vm: JSContext,
    readonly cell: Uint8Array,
    readonly owned: boolean,
  ) {}

  get ptr(): Pointer {
    assert(!this.#disposed, "JSValue is disposed");
    return ptr(this.cell);
  }

  dupCell(): Uint8Array {
    const out = newCell();
    this.vm.native.qjs_bun_dup_value(this.vm.ctx, this.ptr, out);
    return out;
  }

  dump(): unknown {
    return dumpValue(this, new Map());
  }

  errorProperty(name: string): string | undefined {
    return readErrorProperty(this, name);
  }

  thrownMessage(): string {
    return thrownValueMessage(this);
  }

  get type(): JSValueType {
    return valueType(this);
  }

  get classId(): number {
    return this.vm.native.qjs_bun_get_class_id(this.ptr);
  }

  get normTag(): number {
    return this.vm.native.qjs_bun_value_get_norm_tag(this.ptr);
  }

  get float64Value(): number {
    return this.vm.native.qjs_bun_value_get_float64(this.ptr);
  }

  isNumber(): boolean {
    return this.vm.native.qjs_bun_is_number(this.ptr) !== 0;
  }

  isBigInt(): boolean {
    return this.vm.native.qjs_bun_is_bigint(this.vm.ctx, this.ptr) !== 0;
  }

  isBoolean(): boolean {
    return this.vm.native.qjs_bun_is_bool(this.ptr) !== 0;
  }

  isNull(): boolean {
    return this.vm.native.qjs_bun_is_null(this.ptr) !== 0;
  }

  isUndefined(): boolean {
    return this.vm.native.qjs_bun_is_undefined(this.ptr) !== 0;
  }

  isException(): boolean {
    return this.vm.native.qjs_bun_is_exception(this.ptr) !== 0;
  }

  isUninitialized(): boolean {
    return this.vm.native.qjs_bun_is_uninitialized(this.ptr) !== 0;
  }

  isString(): boolean {
    return this.vm.native.qjs_bun_is_string(this.ptr) !== 0;
  }

  isSymbol(): boolean {
    return this.vm.native.qjs_bun_is_symbol(this.ptr) !== 0;
  }

  isObject(): boolean {
    return this.vm.native.qjs_bun_is_object(this.ptr) !== 0;
  }

  isNaN(): boolean {
    return this.vm.native.qjs_bun_value_is_nan(this.ptr) !== 0;
  }

  print(options: JSPrintOptions = {}): string {
    const maxDepth = optionalUint32(options.maxDepth, "maxDepth");
    const maxStringLength = optionalUint32(options.maxStringLength, "maxStringLength");
    const maxItemCount = optionalUint32(options.maxItemCount, "maxItemCount");
    const chunks: string[] = [];
    const write = new JSCallback(
      (_opaque: Pointer, text: Pointer, length: bigint) => {
        chunks.push(length === 0n ? "" : String(new CString(text, 0, Number(length))));
      },
      {
        args: ["ptr", "ptr", "u64"],
        returns: "void",
      },
    );
    assert(write.ptr !== null, "Print callback pointer is null");
    try {
      this.vm.native.qjs_bun_print_value_options(
        this.vm.ctx,
        write.ptr,
        null,
        this.ptr,
        options.showHidden === undefined ? -1 : options.showHidden ? 1 : 0,
        options.rawDump === undefined ? -1 : options.rawDump ? 1 : 0,
        maxDepth,
        maxStringLength,
        maxItemCount,
      );
      return chunks.join("");
    } finally {
      write.close();
    }
  }

  isLiveObject(): boolean {
    return this.vm.native.qjs_bun_is_live_object(this.vm.runtime.ptr, this.ptr) !== 0;
  }

  setIsHTMLDDA(): void {
    this.vm.native.qjs_bun_set_is_html_dda(this.vm.ctx, this.ptr);
  }

  getOpaque(classId: number): Pointer | null {
    assert(
      Number.isSafeInteger(classId) && classId >= 0,
      "classId must be a non-negative safe integer",
    );
    return this.vm.native.qjs_bun_get_opaque(this.ptr, classId) as Pointer | null;
  }

  getOpaque2(classId: number): Pointer | null {
    assert(
      Number.isSafeInteger(classId) && classId >= 0,
      "classId must be a non-negative safe integer",
    );
    const opaque = this.vm.native.qjs_bun_get_opaque2(
      this.vm.ctx,
      this.ptr,
      classId,
    ) as Pointer | null;
    if (opaque === null && this.vm.hasException()) throw this.vm.getException();
    return opaque;
  }

  getAnyOpaque(): JSOpaque | null {
    const classId = new Uint32Array(1);
    const opaque = this.vm.native.qjs_bun_get_any_opaque(this.ptr, classId) as Pointer | null;
    return opaque === null ? null : { classId: classId[0]!, pointer: opaque };
  }

  setOpaque(opaque: Pointer | null): void {
    this.vm.native.qjs_bun_set_opaque(this.ptr, opaque);
  }

  get promiseState(): QuickJSPromiseStateValue {
    const state = this.vm.native.qjs_bun_promise_state(this.vm.ctx, this.ptr);
    assert(
      state === QuickJSPromiseState.NOT_PROMISE ||
        state === QuickJSPromiseState.PENDING ||
        state === QuickJSPromiseState.FULFILLED ||
        state === QuickJSPromiseState.REJECTED,
      `Unknown QuickJS promise state: ${state}`,
    );
    return state;
  }

  get length(): number {
    using length = this.getProp("length");
    return length.toNumber();
  }

  dup(): JSValue {
    const out = newCell();
    this.vm.native.qjs_bun_dup_value(this.vm.ctx, this.ptr, out);
    return new JSValue(this.vm, out, true);
  }

  toAtom(): JSAtom {
    const atom = this.vm.native.qjs_bun_value_to_atom(this.vm.ctx, this.ptr);
    assert(atom !== QuickJSAtom.NULL, "QuickJS atom did not initialize");
    return new JSAtom(this.vm, atom, true);
  }

  call(thisValue: JSValue = this.vm.undefined, ...args: JSValue[]): JSValue {
    return this.vm.callFunction(this, thisValue, ...args);
  }

  invoke(name: string, ...args: JSValue[]): JSValue {
    return this.vm.invoke(this, name, ...args);
  }

  construct(...args: JSValue[]): JSValue {
    return this.vm.callConstructor(this, ...args);
  }

  constructWithNewTarget(newTarget: JSValue, ...args: JSValue[]): JSValue {
    return this.vm.callConstructorWithNewTarget(this, newTarget, ...args);
  }

  getProp(name: string): JSValue {
    const out = newCell();
    using atom = this.vm.newAtom(name);
    this.vm.native.qjs_bun_get_property(this.vm.ctx, this.ptr, atom.value, out);
    return this.vm.resultValue(out);
  }

  getDataProp(name: string): JSValue {
    const out = newCell();
    using atom = this.vm.newAtom(name);
    this.vm.native.qjs_bun_get_data_property(this.vm.ctx, this.ptr, atom.value, out);
    return this.vm.resultValue(out);
  }

  getPropWithReceiver(name: string, receiver: JSValue, throwReferenceError = false): JSValue {
    this.vm.assertSameVM(receiver);
    const out = newCell();
    using atom = this.vm.newAtom(name);
    this.vm.native.qjs_bun_get_property_internal(
      this.vm.ctx,
      this.ptr,
      atom.value,
      receiver.ptr,
      throwReferenceError ? 1 : 0,
      out,
    );
    return this.vm.resultValue(out);
  }

  setProp(name: string, value: JSValue): void {
    this.vm.assertSameVM(value);
    using atom = this.vm.newAtom(name);
    const ownedValue = value.dupCell();
    const ok = this.vm.native.qjs_bun_set_property(
      this.vm.ctx,
      this.ptr,
      atom.value,
      ptr(ownedValue),
    );
    if (ok < 0) throw this.vm.getException();
  }

  setPropWithReceiver(name: string, value: JSValue, receiver: JSValue, flags = 0): void {
    this.vm.assertSameVM(value, receiver);
    using atom = this.vm.newAtom(name);
    const ownedValue = value.dupCell();
    const ok = this.vm.native.qjs_bun_set_property_internal(
      this.vm.ctx,
      this.ptr,
      atom.value,
      ptr(ownedValue),
      receiver.ptr,
      flags,
    );
    if (ok < 0) throw this.vm.getException();
  }

  defineProp(name: string, value: JSValue, flags = QuickJSPropertyFlags.C_W_E): void {
    this.vm.assertSameVM(value);
    using atom = this.vm.newAtom(name);
    const ownedValue = value.dupCell();
    const ok = this.vm.native.qjs_bun_define_property_value(
      this.vm.ctx,
      this.ptr,
      atom.value,
      ptr(ownedValue),
      flags,
    );
    if (ok < 0) throw this.vm.getException();
  }

  defineProps(values: Record<string, HostValue>, flags = QuickJSPropertyFlags.C_W_E): void {
    for (const [name, value] of Object.entries(values)) {
      using handle = this.vm.newValue(value);
      this.defineProp(name, handle, flags);
    }
  }

  definePropGetSet(name: string, getter: JSValue, setter: JSValue, flags = 0): void {
    this.vm.assertSameVM(getter, setter);
    using atom = this.vm.newAtom(name);
    const ownedGetter = getter.dupCell();
    const ownedSetter = setter.dupCell();
    const ok = this.vm.native.qjs_bun_define_property_get_set(
      this.vm.ctx,
      this.ptr,
      atom.value,
      ptr(ownedGetter),
      ptr(ownedSetter),
      flags,
    );
    if (ok < 0) throw this.vm.getException();
  }

  hasProp(name: string): boolean {
    using atom = this.vm.newAtom(name);
    const ok = this.vm.native.qjs_bun_has_property(this.vm.ctx, this.ptr, atom.value);
    if (ok < 0) throw this.vm.getException();
    return ok !== 0;
  }

  deleteProp(name: string, flags = 0): boolean {
    using atom = this.vm.newAtom(name);
    const ok = this.vm.native.qjs_bun_delete_property(this.vm.ctx, this.ptr, atom.value, flags);
    if (ok < 0) throw this.vm.getException();
    return ok !== 0;
  }

  getPrototype(): JSValue {
    const out = newCell();
    this.vm.native.qjs_bun_get_prototype(this.vm.ctx, this.ptr, out);
    return this.vm.resultValue(out);
  }

  setPrototype(prototype: JSValue): void {
    this.vm.assertSameVM(prototype);
    const ok = this.vm.native.qjs_bun_set_prototype(this.vm.ctx, this.ptr, prototype.ptr);
    if (ok < 0) throw this.vm.getException();
  }

  setConstructorBit(constructor = true): void {
    const ok = this.vm.native.qjs_bun_set_constructor_bit(
      this.vm.ctx,
      this.ptr,
      constructor ? 1 : 0,
    );
    if (ok < 0) throw this.vm.getException();
  }

  setConstructor(prototype: JSValue): void {
    this.vm.assertSameVM(prototype);
    const ok = this.vm.native.qjs_bun_set_constructor(this.vm.ctx, this.ptr, prototype.ptr);
    if (ok < 0) throw this.vm.getException();
  }

  isExtensible(): boolean {
    const ok = this.vm.native.qjs_bun_is_extensible(this.vm.ctx, this.ptr);
    if (ok < 0) throw this.vm.getException();
    return ok !== 0;
  }

  preventExtensions(): boolean {
    const ok = this.vm.native.qjs_bun_prevent_extensions(this.vm.ctx, this.ptr);
    if (ok < 0) throw this.vm.getException();
    return ok !== 0;
  }

  isConstructor(): boolean {
    return this.vm.native.qjs_bun_is_constructor(this.vm.ctx, this.ptr) !== 0;
  }

  isInstanceOf(constructor: JSValue): boolean {
    this.vm.assertSameVM(constructor);
    const ok = this.vm.native.qjs_bun_is_instance_of(this.vm.ctx, this.ptr, constructor.ptr);
    if (ok < 0) throw this.vm.getException();
    return ok !== 0;
  }

  strictEquals(other: JSValue): boolean {
    this.vm.assertSameVM(other);
    return this.vm.native.qjs_bun_strict_eq(this.vm.ctx, this.ptr, other.ptr) !== 0;
  }

  sameValue(other: JSValue): boolean {
    this.vm.assertSameVM(other);
    return this.vm.native.qjs_bun_same_value(this.vm.ctx, this.ptr, other.ptr) !== 0;
  }

  sameValueZero(other: JSValue): boolean {
    this.vm.assertSameVM(other);
    return this.vm.native.qjs_bun_same_value_zero(this.vm.ctx, this.ptr, other.ptr) !== 0;
  }

  coerceToString(): JSValue {
    const out = newCell();
    this.vm.native.qjs_bun_to_string(this.vm.ctx, this.ptr, out);
    return this.vm.resultValue(out);
  }

  toPropertyKey(): JSValue {
    const out = newCell();
    this.vm.native.qjs_bun_to_property_key(this.vm.ctx, this.ptr, out);
    return this.vm.resultValue(out);
  }

  typedArrayBuffer(): JSValue {
    const out = newCell();
    this.vm.native.qjs_bun_get_typed_array_buffer(this.vm.ctx, this.ptr, null, null, null, out);
    return this.vm.resultValue(out);
  }

  typedArrayInfo(): JSTypedArrayInfo {
    const byteOffset = new BigUint64Array(1);
    const byteLength = new BigUint64Array(1);
    const bytesPerElement = new BigUint64Array(1);
    const out = newCell();
    this.vm.native.qjs_bun_get_typed_array_buffer(
      this.vm.ctx,
      this.ptr,
      byteOffset,
      byteLength,
      bytesPerElement,
      out,
    );
    return {
      buffer: this.vm.resultValue(out),
      byteOffset: Number(byteOffset[0]!),
      byteLength: Number(byteLength[0]!),
      bytesPerElement: Number(bytesPerElement[0]!),
    };
  }

  writeObject(flags = 0): Uint8Array {
    const size = new Uint8Array(8);
    const bytes = this.vm.native.qjs_bun_write_object(this.vm.ctx, size, this.ptr, flags);
    if (bytes === null) throw this.vm.getException();
    try {
      return new Uint8Array(toArrayBuffer(bytes, 0, Number(read.u64(ptr(size))))).slice();
    } finally {
      this.vm.native.js_free(this.vm.ctx, bytes);
    }
  }

  detachArrayBuffer(): void {
    this.vm.native.qjs_bun_detach_array_buffer(this.vm.ctx, this.ptr);
  }

  arrayBufferBytes(): Uint8Array {
    const size = new Uint8Array(8);
    const data = this.vm.native.qjs_bun_get_array_buffer(this.vm.ctx, size, this.ptr);
    if (data === null) throw this.vm.getException();
    return new Uint8Array(toArrayBuffer(data, 0, Number(read.u64(ptr(size))))).slice();
  }

  coerceToBoolean(): boolean {
    return this.vm.native.qjs_bun_to_bool(this.vm.ctx, this.ptr) !== 0;
  }

  coerceToNumber(): number {
    const out = new Float64Array(1);
    if (this.vm.native.qjs_bun_to_float64(this.vm.ctx, out, this.ptr) < 0)
      throw this.vm.getException();
    return out[0]!;
  }

  coerceToInt32(): number {
    const out = new Int32Array(1);
    if (this.vm.native.qjs_bun_to_int32(this.vm.ctx, out, this.ptr) < 0)
      throw this.vm.getException();
    return out[0]!;
  }

  coerceToUint32(): number {
    const out = new Uint32Array(1);
    if (this.vm.native.qjs_bun_to_uint32(this.vm.ctx, out, this.ptr) < 0)
      throw this.vm.getException();
    return out[0]!;
  }

  coerceToInt64(): bigint {
    const out = new BigInt64Array(1);
    if (this.vm.native.qjs_bun_to_int64(this.vm.ctx, out, this.ptr) < 0)
      throw this.vm.getException();
    return out[0]!;
  }

  coerceToInt64Ext(): bigint {
    const out = new BigInt64Array(1);
    if (this.vm.native.qjs_bun_to_int64_ext(this.vm.ctx, out, this.ptr) < 0)
      throw this.vm.getException();
    return out[0]!;
  }

  coerceToIndex(): bigint {
    const out = new BigUint64Array(1);
    if (this.vm.native.qjs_bun_to_index(this.vm.ctx, out, this.ptr) < 0)
      throw this.vm.getException();
    return out[0]!;
  }

  coerceToBigInt64(): bigint {
    const out = new BigInt64Array(1);
    if (this.vm.native.qjs_bun_to_bigint64(this.vm.ctx, out, this.ptr) < 0)
      throw this.vm.getException();
    return out[0]!;
  }

  getIndex(index: number): JSValue {
    const out = newCell();
    this.vm.native.qjs_bun_get_property_u32(this.vm.ctx, this.ptr, index, out);
    return this.vm.resultValue(out);
  }

  setIndex(index: number, value: JSValue): void {
    this.vm.assertSameVM(value);
    const ownedValue = value.dupCell();
    const ok = this.vm.native.qjs_bun_set_property_u32(
      this.vm.ctx,
      this.ptr,
      index,
      ptr(ownedValue),
    );
    if (ok < 0) throw this.vm.getException();
  }

  setIndex64(index: number | bigint, value: JSValue): void {
    this.vm.assertSameVM(value);
    const ownedValue = value.dupCell();
    const ok = this.vm.native.qjs_bun_set_property_i64(
      this.vm.ctx,
      this.ptr,
      BigInt(index),
      ptr(ownedValue),
    );
    if (ok < 0) throw this.vm.getException();
  }

  defineIndex(index: number, value: JSValue, flags = QuickJSPropertyFlags.C_W_E): void {
    this.vm.assertSameVM(value);
    const ownedValue = value.dupCell();
    const ok = this.vm.native.qjs_bun_define_property_value_u32(
      this.vm.ctx,
      this.ptr,
      index,
      ptr(ownedValue),
      flags,
    );
    if (ok < 0) throw this.vm.getException();
  }

  keys(): string[] {
    const tabCell = new Uint8Array(8);
    const lengthCell = new Uint8Array(4);
    const ok = this.vm.native.qjs_bun_get_own_property_names(
      this.vm.ctx,
      tabCell,
      lengthCell,
      this.ptr,
      QuickJSGetOwnPropertyNamesFlags.STRING_MASK | QuickJSGetOwnPropertyNamesFlags.ENUM_ONLY,
    );
    if (ok < 0) throw this.vm.getException();
    const tab = read.ptr(ptr(tabCell)) as Pointer | null;
    const length = read.u32(ptr(lengthCell));
    try {
      const keys: string[] = [];
      if (length > 0) {
        assert(tab !== null, "QuickJS property table is null");
        for (let index = 0; index < length; index++) {
          const atom = read.u32(tab, index * 8 + 4);
          const size = new Uint8Array(8);
          const keyPtr = this.vm.native.JS_AtomToCStringLen(this.vm.ctx, ptr(size), atom);
          assert(keyPtr !== null, "QuickJS property key is null");
          keys.push(readCString(this.vm, keyPtr, Number(read.u64(ptr(size)))));
        }
      }
      return keys;
    } finally {
      if (tab !== null) this.vm.native.JS_FreePropertyEnum(this.vm.ctx, tab, length);
    }
  }

  promiseResult(): JSValue {
    const state = this.promiseState;
    assert(state !== QuickJSPromiseState.NOT_PROMISE, "QuickJS value is not a promise");
    assert(state !== QuickJSPromiseState.PENDING, "QuickJS promise is pending");
    const out = newCell();
    this.vm.native.qjs_bun_promise_result(this.vm.ctx, this.ptr, out);
    return new JSValue(this.vm, out, true);
  }

  toBoolean(): boolean {
    const type = this.type;
    assert(type === "boolean", `Cannot convert QuickJS ${type} to boolean`);
    return read.i32(this.ptr) !== 0;
  }

  toNumber(): number {
    const type = this.type;
    assert(type === "number", `Cannot convert QuickJS ${type} to number`);
    return valueTag(this.ptr) === QuickJSValueTag.INT ? read.i32(this.ptr) : read.f64(this.ptr);
  }

  toBigInt(): bigint {
    const type = this.type;
    assert(type === "bigint", `Cannot convert QuickJS ${type} to bigint`);
    return BigInt(valueCString(this));
  }

  toString(): string {
    const type = this.type;
    assert(type === "string", `Cannot convert QuickJS ${type} to string`);
    return valueCString(this);
  }

  toError(): Error {
    const type = this.type;
    assert(type === "error", `Cannot convert QuickJS ${type} to error`);
    const error = new Error(readErrorProperty(this, "message") ?? "Error");
    error.name = readErrorProperty(this, "name") ?? "Error";
    error.stack = readErrorProperty(this, "stack") ?? error.stack;
    return error;
  }

  dispose(): void {
    if (!this.owned || this.#disposed) return;
    this.vm.native.qjs_bun_free_value(this.vm.ctx, ptr(this.cell));
    this.#disposed = true;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

function readErrorProperty(handle: JSValue, name: string): string | undefined {
  const out = newCell();
  using atom = handle.vm.newAtom(name);
  handle.vm.native.qjs_bun_get_data_property(handle.vm.ctx, handle.ptr, atom.value, out);
  using value = handle.vm.resultValue(out);
  if (value.type === "undefined") return undefined;
  return primitiveString(value) ?? undefined;
}

function dumpValue(handle: JSValue, seen: Map<Pointer, unknown>): unknown {
  const type = handle.type;
  switch (type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
      return handle.toBoolean();
    case "number":
      return handle.toNumber();
    case "bigint":
      return handle.toBigInt();
    case "string":
      return handle.toString();
    case "array":
    case "object": {
      const pointer = read.ptr(handle.ptr) as Pointer;
      assert(pointer !== null, "QuickJS object pointer is null");
      const existing = seen.get(pointer);
      if (existing !== undefined) return existing;
      if (type === "object") {
        const object: Record<string, unknown> = {};
        seen.set(pointer, object);
        for (const key of handle.keys()) {
          using value = handle.getProp(key);
          Object.defineProperty(object, key, {
            value: dumpValue(value, seen),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return object;
      }
      const array: unknown[] = [];
      seen.set(pointer, array);
      const length = handle.length;
      for (let index = 0; index < length; index++) {
        using entry = handle.getIndex(index);
        array.push(dumpValue(entry, seen));
      }
      return array;
    }
    case "error":
      return handle.toError();
    case "function":
    case "symbol":
      throw new TypeError(`Cannot dump QuickJS ${type}`);
    default: {
      const neverType: any = type;
      throw new TypeError(`Cannot dump QuickJS ${neverType}`);
    }
  }
}

function thrownValueMessage(handle: JSValue): string {
  switch (handle.type) {
    case "undefined":
    case "null":
    case "boolean":
    case "number":
    case "bigint":
    case "string":
      return primitiveString(handle)!;
    case "symbol":
      return "QuickJS symbol was thrown";
    case "function":
      return "QuickJS function was thrown";
    case "array":
      return "QuickJS array was thrown";
    case "object":
      return "QuickJS object was thrown";
    case "error":
      return readErrorProperty(handle, "message") ?? "Error";
  }
}

function primitiveString(handle: JSValue): string | null {
  switch (handle.type) {
    case "undefined":
      return "undefined";
    case "null":
      return "null";
    case "boolean":
      return String(handle.toBoolean());
    case "number":
      return String(handle.toNumber());
    case "bigint":
      return String(handle.toBigInt());
    case "string":
      return handle.toString();
    case "function":
    case "array":
    case "error":
    case "object":
    case "symbol":
      return null;
  }
}

function valueCString(handle: JSValue): string {
  const size = new Uint8Array(8);
  const text = handle.vm.native.qjs_bun_to_cstring_len(handle.vm.ctx, size, handle.ptr);
  if (text === null) throw handle.vm.getException();
  return readCString(handle.vm, text, Number(read.u64(ptr(size))));
}

function valueType(handle: JSValue): JSValueType {
  const tag = valueTag(handle.ptr);
  switch (tag) {
    case QuickJSValueTag.UNDEFINED:
      return "undefined";
    case QuickJSValueTag.NULL:
      return "null";
    case QuickJSValueTag.BOOL:
      return "boolean";
    case QuickJSValueTag.INT:
    case QuickJSValueTag.FLOAT64:
      return "number";
    case QuickJSValueTag.BIG_INT:
    case QuickJSValueTag.SHORT_BIG_INT:
      return "bigint";
    case QuickJSValueTag.STRING:
    case QuickJSValueTag.STRING_ROPE:
      return "string";
    case QuickJSValueTag.SYMBOL:
      return "symbol";
    case QuickJSValueTag.OBJECT:
      if (handle.vm.native.qjs_bun_is_function(handle.vm.ctx, handle.ptr)) return "function";
      {
        const isArray = handle.vm.native.qjs_bun_is_array(handle.vm.ctx, handle.ptr);
        if (isArray < 0) throw handle.vm.getException();
        if (isArray) return "array";
      }
      if (handle.vm.native.qjs_bun_is_error(handle.vm.ctx, handle.ptr)) return "error";
      return "object";
    default:
      throw new TypeError(`Unknown QuickJS value tag: ${tag}`);
  }
}
