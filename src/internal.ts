import { CString, read, type Pointer } from "bun:ffi";
import assert from "node:assert/strict";
import type { JSContext } from "./context";
import { QUICKJS_VALUE_CELL_BYTES, QuickJSValueTag, type QuickJSNative } from "./ffi";
import type { JSBytes, JSIntrinsic } from "./types";
import type { JSValue } from "./value";

export const encoder = new TextEncoder();
export const VALUE_CELL_BYTES = QUICKJS_VALUE_CELL_BYTES;
export const ATOM_TAG_INT = 0x80000000;
export const HOST_REQUEST_HOST_ID_OFFSET = 0;
export const HOST_REQUEST_ARGC_OFFSET = 4;
export const HOST_REQUEST_THIS_OFFSET = 8;
export const HOST_REQUEST_ARGV_OFFSET = 24;
export const HOST_REQUEST_OUT_OFFSET = 32;
export const MAX_HOST_FUNCTION_ID = 0x7fffffff;
export const MIN_INT64 = -(1n << 63n);
export const MAX_INT64 = (1n << 63n) - 1n;
export const MAX_UINT64 = (1n << 64n) - 1n;
export const UNSET_UINT32 = 0xffffffff;
export const defaultIntrinsics = [
  "base",
  "date",
  "eval",
  "stringNormalize",
  "regexp",
  "json",
  "proxy",
  "mapSet",
  "typedArrays",
  "promise",
  "weakRef",
] as const satisfies readonly JSIntrinsic[];

export function readCString(vm: JSContext, text: Pointer, length: number): string {
  const value = length === 0 ? "" : String(new CString(text, 0, length));
  vm.native.JS_FreeCString(vm.ctx, text);
  return value;
}

export function argvCell(args: readonly JSValue[]): Uint8Array | null {
  if (args.length === 0) return null;
  const argv = new Uint8Array(VALUE_CELL_BYTES * args.length);
  for (let index = 0; index < args.length; index++) {
    argv.set(args[index]!.cell, index * VALUE_CELL_BYTES);
  }
  return argv;
}

export function bytesView(bytes: JSBytes): Uint8Array {
  if (!ArrayBuffer.isView(bytes)) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function optionalUint32(value: number | undefined, name: string): number {
  if (value === undefined) return UNSET_UINT32;
  assert(Number.isInteger(value) && value >= 0 && value < UNSET_UINT32, `${name} must be a uint32`);
  return value;
}

export function isTaggedIntAtom(atom: number): boolean {
  return (atom & ATOM_TAG_INT) !== 0;
}

export function untagAtomInt(atom: number): number {
  return atom & ~ATOM_TAG_INT;
}

export function newCell(): Uint8Array {
  return new Uint8Array(VALUE_CELL_BYTES);
}

export function pointerKey(pointer: Pointer): string {
  return String(pointer);
}

export function throwQuickJSError(
  native: QuickJSNative,
  context: Pointer,
  type: "internal" | "range" | "reference" | "syntax" | "type",
  message: string,
): void {
  const out = newCell();
  const text = encoder.encode(`${message}\0`);
  switch (type) {
    case "internal":
      native.qjs_bun_throw_internal_error(context, text, out);
      break;
    case "range":
      native.qjs_bun_throw_range_error(context, text, out);
      break;
    case "reference":
      native.qjs_bun_throw_reference_error(context, text, out);
      break;
    case "syntax":
      native.qjs_bun_throw_syntax_error(context, text, out);
      break;
    case "type":
      native.qjs_bun_throw_type_error(context, text, out);
      break;
  }
}

export function valueTag(value: Pointer): number {
  return Number(read.i64(value, 8));
}

export function writeTaggedInt(tag: number, value: number): Uint8Array {
  const cell = newCell();
  const view = new DataView(cell.buffer, cell.byteOffset, cell.byteLength);
  view.setInt32(0, value, true);
  view.setInt32(4, 0, true);
  view.setBigInt64(8, BigInt(tag), true);
  return cell;
}

export function writeNumber(value: number): Uint8Array {
  if (Number.isInteger(value) && Object.is(value, value | 0)) {
    return writeTaggedInt(QuickJSValueTag.INT, value);
  }
  const cell = newCell();
  const view = new DataView(cell.buffer, cell.byteOffset, cell.byteLength);
  view.setFloat64(0, value, true);
  view.setBigInt64(8, BigInt(QuickJSValueTag.FLOAT64), true);
  return cell;
}
