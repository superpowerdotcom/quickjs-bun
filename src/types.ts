import type { Pointer } from "bun:ffi";
import { QuickJSTypedArray, type QuickJS } from "./ffi";
import type { JSContext } from "./context";
import type { JSModule } from "./module";
import type { JSValue } from "./value";

export type JSIntrinsic =
  | "base"
  | "date"
  | "eval"
  | "stringNormalize"
  | "regexp"
  | "regexpCompiler"
  | "json"
  | "proxy"
  | "mapSet"
  | "typedArrays"
  | "promise"
  | "weakRef";

export type JSIntrinsics = "default" | "minimal" | readonly JSIntrinsic[];

export interface JSRuntimeOptions {
  canBlock?: boolean;
  gcThresholdBytes?: number;
  library: QuickJS;
  memoryBytes?: number;
  runtimeInfo?: string;
  stackBytes?: number;
  stripInfo?: number;
}

export interface JSContextOptions {
  intrinsics?: JSIntrinsics;
  timeoutMs?: number;
}

export interface JSEvalOptions {
  filename?: string;
  flags?: number;
  timeoutMs?: number;
}
export interface JSJsonParseOptions {
  filename?: string;
  flags?: number;
}
export type JSTypedArrayType = (typeof QuickJSTypedArray)[keyof typeof QuickJSTypedArray];
export type JSBytes = ArrayBufferLike | ArrayBufferView<ArrayBufferLike>;
export interface JSTypedArrayInfo {
  buffer: JSValue;
  byteLength: number;
  byteOffset: number;
  bytesPerElement: number;
}
export interface JSOpaque {
  classId: number;
  pointer: Pointer;
}
export interface JSPrintOptions {
  maxDepth?: number;
  maxItemCount?: number;
  maxStringLength?: number;
  rawDump?: boolean;
  showHidden?: boolean;
}
export interface JSDumpOptions {
  maxDepth?: number;
  maxNodes?: number;
}
export type JSModuleInit = (module: JSModule) => void;
export type JSModuleLoader = (
  moduleName: string,
  context: JSContext,
  attributes: JSValue,
) => JSBytes | JSModule | string | null | undefined;
export interface JSPromiseRejection {
  context: JSContext;
  isHandled: boolean;
  promise: JSValue;
  reason: JSValue;
}
export type JSPromiseRejectionTracker = (rejection: JSPromiseRejection) => void;

export type HostValue =
  | JSValue
  | Error
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | HostValue[]
  | { [key: string]: HostValue };

export type HostFunction = (this: JSValue, ...args: JSValue[]) => HostValue | void;

export type JSValueType =
  | "undefined"
  | "null"
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "function"
  | "array"
  | "error"
  | "object"
  | "symbol";

export interface JSMemoryUsage {
  arrayCount: bigint;
  atomCount: bigint;
  atomSize: bigint;
  binaryObjectCount: bigint;
  binaryObjectSize: bigint;
  cFuncCount: bigint;
  fastArrayCount: bigint;
  fastArrayElements: bigint;
  jsFuncCodeSize: bigint;
  jsFuncCount: bigint;
  jsFuncPc2LineCount: bigint;
  jsFuncPc2LineSize: bigint;
  jsFuncSize: bigint;
  mallocCount: bigint;
  mallocLimit: bigint;
  mallocSize: bigint;
  memoryUsedCount: bigint;
  memoryUsedSize: bigint;
  objCount: bigint;
  objSize: bigint;
  propCount: bigint;
  propSize: bigint;
  shapeCount: bigint;
  shapeSize: bigint;
  strCount: bigint;
  strSize: bigint;
}
