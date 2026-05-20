// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./src/ambient.d.ts" />

export { JSAtom } from "./src/atom";
export { JSContext } from "./src/context";
export { Deferred } from "./src/deferred";
export { JSException } from "./src/exception";
export { JSModule } from "./src/module";
export { JSRuntime } from "./src/runtime";
export { JSValue } from "./src/value";

export {
  QuickJS,
  QuickJSAtom,
  QuickJSCallFlags,
  QuickJSClassId,
  QuickJSCFunction,
  QuickJSEvalFlags,
  QuickJSFunctionListEntry,
  QuickJSGetOwnPropertyNamesFlags,
  QuickJSParseJsonFlags,
  QuickJSPromiseState,
  QuickJSPropertyFlags,
  QuickJSReadObjectFlags,
  QuickJSStripFlags,
  QuickJSTypedArray,
  QuickJSValueTag,
  QuickJSWriteObjectFlags,
  QUICKJS_DEFAULT_STACK_SIZE,
  QUICKJS_VALUE_CELL_BYTES,
  QUICKJS_VERSION_TEXT,
  type QuickJSNative,
  type QuickJSOptions,
  type QuickJSPath,
  type QuickJSPromiseStateValue,
} from "./src/ffi";

export type {
  HostFunction,
  HostValue,
  JSValueType,
  JSBytes,
  JSContextOptions,
  JSEvalOptions,
  JSIntrinsic,
  JSIntrinsics,
  JSJsonParseOptions,
  JSMemoryUsage,
  JSModuleInit,
  JSModuleLoader,
  JSOpaque,
  JSPrintOptions,
  JSPromiseRejection,
  JSPromiseRejectionTracker,
  JSRuntimeOptions,
  JSTypedArrayInfo,
  JSTypedArrayType,
} from "./src/types";
