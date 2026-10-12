import assert from "node:assert/strict";
import { CString, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import type { JSContext } from "./context";
import {
  cstring,
  QuickJSAtom,
  QuickJSGetOwnPropertyNamesFlags,
  QuickJSPrimitiveHint,
  QuickJSPromiseState,
  QuickJSPropertyFlags,
  QuickJSValueTag,
  type QuickJSPromiseStateValue,
} from "./ffi";
import type {
  HostValue,
  JSDumpOptions,
  JSOpaque,
  JSPrintOptions,
  JSPropertyDefinition,
  JSPropertyDescriptor,
  JSTypedArrayInfo,
  JSValueType,
} from "./types";

const types: readonly JSValueType[] = [
  "undefined",
  "null",
  "boolean",
  "number",
  "bigint",
  "string",
  "symbol",
  "object",
  "function",
  "array",
  "error",
];

export class JSValue {
  readonly #address: Pointer;
  #slot = -1;
  #disposed = false;

  constructor(
    readonly vm: JSContext,
    readonly cell: Uint8Array,
    readonly owned: boolean,
  ) {
    this.#address = ptr(cell);
    if (owned && read.i32(this.#address, 8) < 0) {
      this.#slot = vm.handles.length;
      vm.handles.push(this);
    }
  }

  get ptr(): Pointer {
    assert(!this.#disposed, "JSValue is disposed");
    return this.#address;
  }

  get tag(): number {
    return read.i32(this.ptr, 8);
  }

  get type(): JSValueType {
    const code = this.vm.native.qjs_bun_type(this.vm.ctx, this.ptr);
    if (code === -1) throw this.vm.getException();
    const type = types[code];
    if (type === undefined) throw new TypeError(`Unknown QuickJS value tag: ${this.tag}`);
    return type;
  }

  get classId(): number {
    return this.vm.native.qjs_bun_get_class_id(this.ptr);
  }

  get float64Value(): number {
    return read.f64(this.ptr);
  }

  get length(): number {
    using length = this.getProp("length");
    return length.toNumber();
  }

  get promiseState(): QuickJSPromiseStateValue {
    const state = this.vm.native.qjs_bun_promise_state(this.vm.ctx, this.ptr);
    assert(state >= -1 && state <= 2, `Unknown QuickJS promise state: ${state}`);
    return state as QuickJSPromiseStateValue;
  }

  isNumber(): boolean {
    const tag = this.tag;
    return tag === QuickJSValueTag.INT || tag === QuickJSValueTag.FLOAT64;
  }

  isBigInt(): boolean {
    const tag = this.tag;
    return tag === QuickJSValueTag.BIG_INT || tag === QuickJSValueTag.SHORT_BIG_INT;
  }

  isBoolean(): boolean {
    return this.tag === QuickJSValueTag.BOOL;
  }

  isNull(): boolean {
    return this.tag === QuickJSValueTag.NULL;
  }

  isUndefined(): boolean {
    return this.tag === QuickJSValueTag.UNDEFINED;
  }

  isException(): boolean {
    return this.tag === QuickJSValueTag.EXCEPTION;
  }

  isUninitialized(): boolean {
    return this.tag === QuickJSValueTag.UNINITIALIZED;
  }

  isString(): boolean {
    const tag = this.tag;
    return tag === QuickJSValueTag.STRING || tag === QuickJSValueTag.STRING_ROPE;
  }

  isSymbol(): boolean {
    return this.tag === QuickJSValueTag.SYMBOL;
  }

  isObject(): boolean {
    return this.tag === QuickJSValueTag.OBJECT;
  }

  isNaN(): boolean {
    return this.tag === QuickJSValueTag.FLOAT64 && Number.isNaN(read.f64(this.ptr));
  }

  isLiveObject(): boolean {
    return this.vm.native.qjs_bun_is_live_object(this.vm.runtime.ptr, this.ptr) !== 0;
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

  ordinaryIsInstanceOf(constructor: JSValue): boolean {
    this.vm.assertSameVM(constructor);
    const ok = this.vm.native.qjs_bun_ordinary_is_instance_of(
      this.vm.ctx,
      this.ptr,
      constructor.ptr,
    );
    if (ok < 0) throw this.vm.getException();
    return ok !== 0;
  }

  print(options: JSPrintOptions = {}): string {
    const uint32 = (value: number | undefined, name: string) => {
      if (value === undefined) return 0xffffffff;
      assert(
        Number.isInteger(value) && value >= 0 && value < 0xffffffff,
        `${name} must be a uint32`,
      );
      return value;
    };
    const length = new BigUint64Array(1);
    const text = this.vm.native.qjs_bun_print(
      this.vm.ctx,
      this.ptr,
      options.showHidden === undefined ? -1 : options.showHidden ? 1 : 0,
      options.rawDump === undefined ? -1 : options.rawDump ? 1 : 0,
      uint32(options.maxDepth, "maxDepth"),
      uint32(options.maxStringLength, "maxStringLength"),
      uint32(options.maxItemCount, "maxItemCount"),
      length,
    );
    if (typeof text !== "number") return "";
    try {
      return new CString(text, 0, Number(length[0])) as string;
    } finally {
      this.vm.native.js_free(this.vm.ctx, text);
    }
  }

  setIsHTMLDDA(): void {
    this.vm.native.qjs_bun_set_is_html_dda(this.vm.ctx, this.ptr);
  }

  getOpaque(classId: number): Pointer | null {
    const opaque = this.vm.native.qjs_bun_get_opaque(this.ptr, classId);
    return typeof opaque === "number" ? opaque : null;
  }

  getOpaque2(classId: number): Pointer | null {
    const opaque = this.vm.native.qjs_bun_get_opaque2(this.vm.ctx, this.ptr, classId);
    if (typeof opaque === "number") return opaque;
    if (this.vm.hasException()) throw this.vm.getException();
    return null;
  }

  getAnyOpaque(): JSOpaque | null {
    const classId = new Uint32Array(1);
    const opaque = this.vm.native.qjs_bun_get_any_opaque(this.ptr, classId);
    return typeof opaque === "number" ? { classId: classId[0]!, pointer: opaque } : null;
  }

  setOpaque(opaque: Pointer | number | null): void {
    this.vm.native.qjs_bun_set_opaque(this.ptr, opaque as Pointer | null);
  }

  dump(options: JSDumpOptions = {}): unknown {
    return this.vm.dump(this, options);
  }

  dup(): JSValue {
    const cell = new Uint8Array(16);
    if (this.tag < 0) this.vm.native.qjs_bun_dup_value(this.vm.ctx, cell, this.ptr);
    else cell.set(this.cell);
    return new JSValue(this.vm, cell, true);
  }

  toAtom(): JSAtom {
    const atom = this.vm.native.qjs_bun_value_to_atom(this.vm.ctx, this.ptr);
    if (atom === QuickJSAtom.NULL) throw this.vm.getException();
    return new JSAtom(this.vm, atom, true);
  }

  call(thisValue: JSValue = this.vm.undefined, ...args: JSValue[]): JSValue {
    return this.vm.callFunction(this, thisValue, ...args);
  }

  invoke(name: string | number | JSAtom, ...args: JSValue[]): JSValue {
    return this.vm.invoke(this, name, ...args);
  }

  construct(...args: JSValue[]): JSValue {
    return this.vm.callConstructor(this, ...args);
  }

  constructWithNewTarget(newTarget: JSValue, ...args: JSValue[]): JSValue {
    return this.vm.callConstructorWithNewTarget(this, newTarget, ...args);
  }

  getProp(key: string | number | JSAtom): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_get_property(this.vm.ctx, out, this.ptr, this.vm.atom(key));
    return this.vm.resultValue(out);
  }

  getDataProp(key: string | number | JSAtom): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_get_data_property(this.vm.ctx, this.ptr, this.vm.atom(key), out);
    return this.vm.resultValue(out);
  }

  getPropWithReceiver(
    key: string | number | JSAtom,
    receiver: JSValue,
    throwReferenceError = false,
  ): JSValue {
    this.vm.assertSameVM(receiver);
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_get_property_internal(
      this.vm.ctx,
      out,
      this.ptr,
      this.vm.atom(key),
      receiver.ptr,
      throwReferenceError ? 1 : 0,
    );
    return this.vm.resultValue(out);
  }

  setProp(key: string | number | JSAtom, value: JSValue): void {
    this.vm.assertSameVM(value);
    const ok = this.vm.native.qjs_bun_set_property(
      this.vm.ctx,
      this.ptr,
      this.vm.atom(key),
      value.ptr,
    );
    if (ok < 0) throw this.vm.getException();
  }

  setPropWithReceiver(
    key: string | number | JSAtom,
    value: JSValue,
    receiver: JSValue,
    flags = 0,
  ): void {
    this.vm.assertSameVM(value, receiver);
    const ok = this.vm.native.qjs_bun_set_property_internal(
      this.vm.ctx,
      this.ptr,
      this.vm.atom(key),
      value.ptr,
      receiver.ptr,
      flags,
    );
    if (ok < 0) throw this.vm.getException();
  }

  defineProp(
    key: string | number | JSAtom,
    value: JSValue,
    flags: number = QuickJSPropertyFlags.C_W_E,
  ): void {
    this.vm.assertSameVM(value);
    const ok = this.vm.native.qjs_bun_define_property_value(
      this.vm.ctx,
      this.ptr,
      this.vm.atom(key),
      value.ptr,
      flags,
    );
    if (ok < 0) throw this.vm.getException();
  }

  defineProps(values: Record<string, HostValue>, flags: number = QuickJSPropertyFlags.C_W_E): void {
    for (const [name, value] of Object.entries(values)) {
      using handle = this.vm.newValue(value);
      this.defineProp(name, handle, flags);
    }
  }

  definePropGetSet(
    key: string | number | JSAtom,
    getter: JSValue,
    setter: JSValue,
    flags = 0,
  ): void {
    this.vm.assertSameVM(getter, setter);
    const ok = this.vm.native.qjs_bun_define_property_get_set(
      this.vm.ctx,
      this.ptr,
      this.vm.atom(key),
      getter.ptr,
      setter.ptr,
      flags,
    );
    if (ok < 0) throw this.vm.getException();
  }

  defineProperty(key: string | number | JSAtom, definition: JSPropertyDefinition): void {
    const value = definition.value ?? this.vm.undefined;
    const getter = definition.get ?? this.vm.undefined;
    const setter = definition.set ?? this.vm.undefined;
    this.vm.assertSameVM(value, getter, setter);
    let flags = definition.flags ?? 0;
    if (definition.value !== undefined) flags |= QuickJSPropertyFlags.HAS_VALUE;
    if (definition.get !== undefined) flags |= QuickJSPropertyFlags.HAS_GET;
    if (definition.set !== undefined) flags |= QuickJSPropertyFlags.HAS_SET;
    const ok = this.vm.native.qjs_bun_define_property(
      this.vm.ctx,
      this.ptr,
      this.vm.atom(key),
      value.ptr,
      getter.ptr,
      setter.ptr,
      flags,
    );
    if (ok < 0) throw this.vm.getException();
  }

  getOwnPropertyDescriptor(key: string | number | JSAtom): JSPropertyDescriptor | undefined {
    const descriptor = new Uint8Array(56);
    const ok = this.vm.native.qjs_bun_get_own_property(
      this.vm.ctx,
      descriptor,
      this.ptr,
      this.vm.atom(key),
    );
    if (ok < 0) throw this.vm.getException();
    if (ok === 0) return undefined;
    return {
      flags: read.i32(ptr(descriptor)),
      value: new JSValue(this.vm, descriptor.slice(8, 24), true),
      get: new JSValue(this.vm, descriptor.slice(24, 40), true),
      set: new JSValue(this.vm, descriptor.slice(40, 56), true),
    };
  }

  hasProp(key: string | number | JSAtom): boolean {
    const ok = this.vm.native.qjs_bun_has_property(this.vm.ctx, this.ptr, this.vm.atom(key));
    if (ok < 0) throw this.vm.getException();
    return ok !== 0;
  }

  deleteProp(key: string | number | JSAtom, flags = 0): boolean {
    const ok = this.vm.native.qjs_bun_delete_property(
      this.vm.ctx,
      this.ptr,
      this.vm.atom(key),
      flags,
    );
    if (ok < 0) throw this.vm.getException();
    return ok !== 0;
  }

  getPrototype(): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_get_prototype(this.vm.ctx, out, this.ptr);
    return this.vm.resultValue(out);
  }

  setPrototype(prototype: JSValue): void {
    this.vm.assertSameVM(prototype);
    if (this.vm.native.qjs_bun_set_prototype(this.vm.ctx, this.ptr, prototype.ptr) < 0) {
      throw this.vm.getException();
    }
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
    if (this.vm.native.qjs_bun_set_constructor(this.vm.ctx, this.ptr, prototype.ptr) < 0) {
      throw this.vm.getException();
    }
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
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_to_string(this.vm.ctx, out, this.ptr);
    return this.vm.resultValue(out);
  }

  coerceToObject(): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_to_object(this.vm.ctx, out, this.ptr);
    return this.vm.resultValue(out);
  }

  coerceToPrimitive(hint: number = QuickJSPrimitiveHint.NONE): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_to_primitive(this.vm.ctx, out, this.ptr, hint);
    return this.vm.resultValue(out);
  }

  toPropertyKey(): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_to_property_key(this.vm.ctx, out, this.ptr);
    return this.vm.resultValue(out);
  }

  coerceToBoolean(): boolean {
    const ok = this.vm.native.qjs_bun_to_bool(this.vm.ctx, this.ptr);
    if (ok < 0) throw this.vm.getException();
    return ok !== 0;
  }

  coerceToNumber(): number {
    const out = new Float64Array(1);
    if (this.vm.native.qjs_bun_to_float64(this.vm.ctx, out, this.ptr) < 0) {
      throw this.vm.getException();
    }
    return out[0]!;
  }

  coerceToInt32(): number {
    const out = new Int32Array(1);
    if (this.vm.native.qjs_bun_to_int32(this.vm.ctx, out, this.ptr) < 0) {
      throw this.vm.getException();
    }
    return out[0]!;
  }

  coerceToInt32Saturated(): number {
    const out = new Int32Array(1);
    if (this.vm.native.qjs_bun_to_int32_sat(this.vm.ctx, out, this.ptr) < 0) {
      throw this.vm.getException();
    }
    return out[0]!;
  }

  coerceToUint32(): number {
    const out = new Uint32Array(1);
    if (this.vm.native.qjs_bun_to_uint32(this.vm.ctx, out, this.ptr) < 0) {
      throw this.vm.getException();
    }
    return out[0]!;
  }

  coerceToInt64(): bigint {
    const out = new BigInt64Array(1);
    if (this.vm.native.qjs_bun_to_int64(this.vm.ctx, out, this.ptr) < 0) {
      throw this.vm.getException();
    }
    return out[0]!;
  }

  coerceToInt64Ext(): bigint {
    const out = new BigInt64Array(1);
    if (this.vm.native.qjs_bun_to_int64_ext(this.vm.ctx, out, this.ptr) < 0) {
      throw this.vm.getException();
    }
    return out[0]!;
  }

  coerceToIndex(): bigint {
    const out = new BigUint64Array(1);
    if (this.vm.native.qjs_bun_to_index(this.vm.ctx, out, this.ptr) < 0) {
      throw this.vm.getException();
    }
    return out[0]!;
  }

  coerceToBigInt64(): bigint {
    const out = new BigInt64Array(1);
    if (this.vm.native.qjs_bun_to_bigint64(this.vm.ctx, out, this.ptr) < 0) {
      throw this.vm.getException();
    }
    return out[0]!;
  }

  typedArrayBuffer(): JSValue {
    return this.typedArrayInfo().buffer;
  }

  typedArrayInfo(): JSTypedArrayInfo {
    const info = new BigUint64Array(3);
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_get_typed_array_buffer(
      this.vm.ctx,
      out,
      this.ptr,
      info.subarray(0, 1),
      info.subarray(1, 2),
      info.subarray(2, 3),
    );
    return {
      buffer: this.vm.resultValue(out),
      byteOffset: Number(info[0]!),
      byteLength: Number(info[1]!),
      bytesPerElement: Number(info[2]!),
    };
  }

  writeObject(flags = 0): Uint8Array {
    const size = new BigUint64Array(1);
    const data = this.vm.native.qjs_bun_write_object(this.vm.ctx, size, this.ptr, flags);
    if (typeof data !== "number") throw this.vm.getException();
    try {
      return new Uint8Array(toArrayBuffer(data, 0, Number(size[0]!))).slice();
    } finally {
      this.vm.native.js_free(this.vm.ctx, data);
    }
  }

  arrayBufferBytes(): Uint8Array {
    const size = new BigUint64Array(1);
    const data = this.vm.native.qjs_bun_get_array_buffer(this.vm.ctx, size, this.ptr);
    if (typeof data !== "number") throw this.vm.getException();
    return new Uint8Array(toArrayBuffer(data, 0, Number(size[0]!))).slice();
  }

  detachArrayBuffer(): void {
    this.vm.native.qjs_bun_detach_array_buffer(this.vm.ctx, this.ptr);
  }

  getIndex(index: number): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_get_property_u32(this.vm.ctx, out, this.ptr, index);
    return this.vm.resultValue(out);
  }

  setIndex(index: number, value: JSValue): void {
    this.vm.assertSameVM(value);
    if (this.vm.native.qjs_bun_set_property_u32(this.vm.ctx, this.ptr, index, value.ptr) < 0) {
      throw this.vm.getException();
    }
  }

  setIndex64(index: number | bigint, value: JSValue): void {
    this.vm.assertSameVM(value);
    const ok = this.vm.native.qjs_bun_set_property_i64(
      this.vm.ctx,
      this.ptr,
      BigInt(index),
      value.ptr,
    );
    if (ok < 0) throw this.vm.getException();
  }

  defineIndex(index: number, value: JSValue, flags: number = QuickJSPropertyFlags.C_W_E): void {
    this.vm.assertSameVM(value);
    const ok = this.vm.native.qjs_bun_define_property_value_u32(
      this.vm.ctx,
      this.ptr,
      index,
      value.ptr,
      flags,
    );
    if (ok < 0) throw this.vm.getException();
  }

  keys(
    flags: number = QuickJSGetOwnPropertyNamesFlags.STRING_MASK |
      QuickJSGetOwnPropertyNamesFlags.ENUM_ONLY,
  ): string[] {
    const { vm } = this;
    let { scratch } = vm;
    let count = Number(
      vm.native.qjs_bun_own_keys(vm.ctx, this.ptr, flags, scratch, scratch.byteLength),
    );
    if (count < -1) {
      scratch = vm.scratch = Buffer.allocUnsafe(-count * 2);
      count = Number(
        vm.native.qjs_bun_own_keys(vm.ctx, this.ptr, flags, scratch, scratch.byteLength),
      );
    }
    if (count < 0) throw vm.getException();
    const keys: string[] = [];
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const length = scratch.readUInt32LE(offset);
      keys.push(scratch.toString("utf8", offset + 4, offset + 4 + length));
      offset += 4 + length;
    }
    return keys;
  }

  ownAtoms(
    flags: number = QuickJSGetOwnPropertyNamesFlags.STRING_MASK |
      QuickJSGetOwnPropertyNamesFlags.SYMBOL_MASK,
  ): JSAtom[] {
    const table = new BigUint64Array(1);
    const count = new Uint32Array(1);
    const ok = this.vm.native.qjs_bun_get_own_property_names(
      this.vm.ctx,
      table,
      count,
      this.ptr,
      flags,
    );
    if (ok < 0) throw this.vm.getException();
    const entries = Number(table[0]!) as Pointer;
    const atoms: JSAtom[] = [];
    for (let index = 0; index < count[0]!; index++) {
      const atom = read.u32(entries, index * 8 + 4);
      atoms.push(new JSAtom(this.vm, this.vm.native.JS_DupAtom(this.vm.ctx, atom), true));
    }
    this.vm.native.JS_FreePropertyEnum(this.vm.ctx, entries, count[0]!);
    return atoms;
  }

  *[Symbol.iterator](): Generator<JSValue, void, undefined> {
    const { vm } = this;
    const out = new Uint8Array(16);
    vm.native.qjs_bun_get_iterator(vm.ctx, out, this.ptr, 0);
    using iterator = vm.resultValue(out);
    using next = iterator.getProp("next");
    const done = new Int32Array(1);
    let finished = false;
    try {
      for (;;) {
        const cell = new Uint8Array(16);
        vm.native.qjs_bun_iterator_next(vm.ctx, cell, iterator.ptr, next.ptr, done);
        const value = vm.resultValue(cell);
        if (done[0] !== 0) {
          finished = true;
          value.dispose();
          return;
        }
        yield value;
      }
    } finally {
      if (!finished && vm.native.qjs_bun_iterator_close(vm.ctx, iterator.ptr, 0) < 0) {
        vm.getException().dispose();
      }
    }
  }

  promiseResult(): JSValue {
    const state = this.promiseState;
    assert(state !== QuickJSPromiseState.NOT_PROMISE, "QuickJS value is not a promise");
    assert(state !== QuickJSPromiseState.PENDING, "QuickJS promise is pending");
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_promise_result(this.vm.ctx, out, this.ptr);
    return new JSValue(this.vm, out, true);
  }

  errorProperty(name: string): string | undefined {
    using value = this.getDataProp(name);
    return value.isUndefined() ? undefined : value.#primitive();
  }

  thrownMessage(): string {
    switch (this.type) {
      case "error":
        return this.errorProperty("message") ?? "Error";
      case "symbol":
        return "QuickJS symbol was thrown";
      case "function":
        return "QuickJS function was thrown";
      case "array":
        return "QuickJS array was thrown";
      case "object":
        return "QuickJS object was thrown";
      default:
        return this.#primitive()!;
    }
  }

  toBoolean(): boolean {
    if (this.tag !== QuickJSValueTag.BOOL) {
      throw new TypeError(`Cannot convert QuickJS ${this.type} to boolean`);
    }
    return read.i32(this.ptr) !== 0;
  }

  toNumber(): number {
    const tag = this.tag;
    if (tag === QuickJSValueTag.INT) return read.i32(this.ptr);
    if (tag === QuickJSValueTag.FLOAT64) return read.f64(this.ptr);
    throw new TypeError(`Cannot convert QuickJS ${this.type} to number`);
  }

  toBigInt(): bigint {
    if (!this.isBigInt()) throw new TypeError(`Cannot convert QuickJS ${this.type} to bigint`);
    const parts = new BigUint64Array(2);
    const status = this.vm.native.qjs_bun_to_bigint128(
      this.vm.ctx,
      parts.subarray(0, 1),
      parts.subarray(1, 2),
      this.ptr,
    );
    if (status < 0) throw this.vm.getException();
    if (status === 0) return BigInt.asIntN(128, (parts[1]! << 64n) | parts[0]!);
    return BigInt(this.#text());
  }

  toString(): string {
    if (!this.isString()) throw new TypeError(`Cannot convert QuickJS ${this.type} to string`);
    return this.#text();
  }

  toError(): Error {
    const type = this.type;
    if (type !== "error") throw new TypeError(`Cannot convert QuickJS ${type} to error`);
    const error = new Error(this.errorProperty("message") ?? "Error");
    error.name = this.errorProperty("name") ?? "Error";
    error.stack = this.errorProperty("stack") ?? error.stack;
    return error;
  }

  toDate(): Date {
    const out = new Float64Array(1);
    if (this.vm.native.qjs_bun_date_value(this.vm.ctx, out, this.ptr) < 0) {
      throw this.vm.getException();
    }
    return new Date(out[0]!);
  }

  dispose(): void {
    if (!this.owned || this.#disposed) return;
    this.#disposed = true;
    if (this.#slot < 0) return;
    const { handles } = this.vm;
    const last = handles.pop()!;
    if (last !== this) {
      handles[this.#slot] = last;
      last.#slot = this.#slot;
    }
    if (!this.vm.disposed) this.vm.native.qjs_bun_free_value(this.vm.ctx, this.#address);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #text(): string {
    const { vm } = this;
    let { scratch } = vm;
    let length = Number(
      vm.native.qjs_bun_to_cstring_copy(vm.ctx, this.ptr, scratch, scratch.byteLength),
    );
    if (length > scratch.byteLength) {
      scratch = vm.scratch = Buffer.allocUnsafe(length * 2);
      length = Number(
        vm.native.qjs_bun_to_cstring_copy(vm.ctx, this.ptr, scratch, scratch.byteLength),
      );
    }
    if (length < 0) throw vm.getException();
    return scratch.toString("utf8", 0, length);
  }

  #primitive(): string | undefined {
    switch (this.tag) {
      case QuickJSValueTag.UNDEFINED:
        return "undefined";
      case QuickJSValueTag.NULL:
        return "null";
      case QuickJSValueTag.BOOL:
        return String(this.toBoolean());
      case QuickJSValueTag.INT:
      case QuickJSValueTag.FLOAT64:
        return String(this.toNumber());
      case QuickJSValueTag.BIG_INT:
      case QuickJSValueTag.SHORT_BIG_INT:
        return String(this.toBigInt());
      case QuickJSValueTag.STRING:
      case QuickJSValueTag.STRING_ROPE:
        return this.#text();
      default:
        return undefined;
    }
  }
}

export class JSAtom {
  #disposed = false;

  constructor(
    readonly vm: JSContext,
    readonly value: number,
    readonly owned: boolean,
  ) {}

  dup(): JSAtom {
    assert(!this.#disposed, "QuickJS atom is disposed");
    if ((this.value & QuickJSAtom.TAG_INT) !== 0) return new JSAtom(this.vm, this.value, false);
    return new JSAtom(this.vm, this.vm.native.JS_DupAtom(this.vm.ctx, this.value), true);
  }

  toValue(): JSValue {
    assert(!this.#disposed, "QuickJS atom is disposed");
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_atom_to_value(this.vm.ctx, out, this.value);
    return this.vm.resultValue(out);
  }

  toStringValue(): JSValue {
    assert(!this.#disposed, "QuickJS atom is disposed");
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_atom_to_string(this.vm.ctx, out, this.value);
    return this.vm.resultValue(out);
  }

  toString(): string {
    assert(!this.#disposed, "QuickJS atom is disposed");
    if ((this.value & QuickJSAtom.TAG_INT) !== 0) return String(this.value & QuickJSAtom.MAX_INT);
    const size = new BigUint64Array(1);
    const text = this.vm.native.JS_AtomToCStringLen(this.vm.ctx, size, this.value);
    assert(typeof text === "number", "QuickJS atom string is null");
    try {
      return new CString(text, 0, Number(size[0]!)) as string;
    } finally {
      this.vm.native.JS_FreeCString(this.vm.ctx, text);
    }
  }

  dispose(): void {
    if (!this.owned || this.#disposed) return;
    this.#disposed = true;
    if ((this.value & QuickJSAtom.TAG_INT) === 0 && !this.vm.disposed) {
      this.vm.native.JS_FreeAtom(this.vm.ctx, this.value);
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

export class JSModule {
  constructor(
    readonly vm: JSContext,
    readonly ptr: Pointer,
  ) {}

  addExport(name: string): void {
    if (this.vm.native.JS_AddModuleExport(this.vm.ctx, this.ptr, cstring(name)) < 0) {
      throw this.vm.getException();
    }
  }

  addExports(names: readonly string[]): void {
    for (const name of names) this.addExport(name);
  }

  setExport(name: string, value: JSValue): void {
    this.vm.assertSameVM(value);
    const ok = this.vm.native.qjs_bun_set_module_export(
      this.vm.ctx,
      this.ptr,
      cstring(name),
      value.ptr,
    );
    if (ok < 0) throw this.vm.getException();
  }

  setExports(values: Record<string, HostValue>): void {
    for (const [name, value] of Object.entries(values)) {
      using handle = this.vm.newValue(value);
      this.setExport(name, handle);
    }
  }

  getNameAtom(): JSAtom {
    const atom = this.vm.native.JS_GetModuleName(this.vm.ctx, this.ptr);
    assert(atom !== QuickJSAtom.NULL, "JS_GetModuleName returned null");
    return new JSAtom(this.vm, atom, true);
  }

  getImportMeta(): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_get_import_meta(this.vm.ctx, out, this.ptr);
    return this.vm.resultValue(out);
  }

  getNamespace(): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_get_module_namespace(this.vm.ctx, out, this.ptr);
    return this.vm.resultValue(out);
  }

  getPrivateValue(): JSValue {
    const out = new Uint8Array(16);
    this.vm.native.qjs_bun_get_module_private_value(this.vm.ctx, out, this.ptr);
    return this.vm.resultValue(out);
  }

  setPrivateValue(value: JSValue): void {
    this.vm.assertSameVM(value);
    if (this.vm.native.qjs_bun_set_module_private_value(this.vm.ctx, this.ptr, value.ptr) < 0) {
      throw this.vm.getException();
    }
  }
}

export class Deferred {
  constructor(
    readonly promise: JSValue,
    readonly resolveFunction: JSValue,
    readonly rejectFunction: JSValue,
  ) {
    promise.vm.assertSameVM(resolveFunction, rejectFunction);
  }

  resolve(value: JSValue): void {
    this.promise.vm.callFunction(this.resolveFunction, this.promise.vm.undefined, value).dispose();
  }

  reject(value: JSValue): void {
    this.promise.vm.callFunction(this.rejectFunction, this.promise.vm.undefined, value).dispose();
  }

  dispose(): void {
    this.promise.dispose();
    this.resolveFunction.dispose();
    this.rejectFunction.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

export class JSException extends Error {
  readonly value: JSValue;

  constructor(value: JSValue) {
    const isError = value.type === "error";
    const name = isError ? (value.errorProperty("name") ?? "Error") : "JSException";
    const message = isError ? (value.errorProperty("message") ?? "Error") : value.thrownMessage();
    super(message);
    this.name = name;
    if (isError) this.stack = value.errorProperty("stack") ?? this.stack;
    this.value = value;
  }

  dispose(): void {
    this.value.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
