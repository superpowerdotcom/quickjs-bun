import { FFIType, JSCallback, cc, dlopen, type Library, type Pointer } from "bun:ffi";
import quickJSVersionText from "../quickjs/VERSION" with { type: "text" };
import type { JSRuntime } from "./runtime";

const sourcePath = (path: string) => Bun.fileURLToPath(new URL(path, import.meta.url));
const quickJSSources = [
  sourcePath("./native/quickjs.c"),
  sourcePath("../quickjs/cutils.c"),
  sourcePath("../quickjs/libunicode.c"),
  sourcePath("../quickjs/libregexp.c"),
  sourcePath("../quickjs/dtoa.c"),
  sourcePath("./native/alloca.S"),
];
const quickJSLibraries = ["m"];
const nativeInclude = [
  sourcePath("./native/"),
  sourcePath("../quickjs/"),
  ...(process.env.QUICKJS_BUN_NATIVE_INCLUDE?.split(":").filter(Boolean) ?? []),
];

export type QuickJSPath = string | URL;
export interface QuickJSOptions {
  path?: QuickJSPath;
}

export const QUICKJS_VERSION_TEXT = quickJSVersionText.trim();

export const QUICKJS_VALUE_CELL_BYTES = 16;

const usize = FFIType.u64_fast;
type FFIArg = "buffer" | "f64" | "i32" | "i64" | "ptr" | "u32" | "u64" | typeof usize;
type FFIReturn = FFIArg | "void";

const fn = <const Args extends readonly FFIArg[], const Return extends FFIReturn>(
  args: Args,
  returns: Return,
) => ({ args, returns });
const voidFn = <const Args extends readonly FFIArg[]>(args: Args) => fn(args, "void");

export const QuickJSValueTag = {
  FIRST: -9,
  BIG_INT: -9,
  SYMBOL: -8,
  STRING: -7,
  STRING_ROPE: -6,
  MODULE: -3,
  FUNCTION_BYTECODE: -2,
  OBJECT: -1,
  INT: 0,
  BOOL: 1,
  NULL: 2,
  UNDEFINED: 3,
  UNINITIALIZED: 4,
  CATCH_OFFSET: 5,
  EXCEPTION: 6,
  SHORT_BIG_INT: 7,
  FLOAT64: 8,
} as const;

export const QuickJSEvalFlags = {
  TYPE_GLOBAL: 0 << 0,
  TYPE_MODULE: 1 << 0,
  TYPE_DIRECT: 2 << 0,
  TYPE_INDIRECT: 3 << 0,
  TYPE_MASK: 3 << 0,
  STRICT: 1 << 3,
  COMPILE_ONLY: 1 << 5,
  BACKTRACE_BARRIER: 1 << 6,
  ASYNC: 1 << 7,
} as const;

export const QuickJSPropertyFlags = {
  CONFIGURABLE: 1 << 0,
  WRITABLE: 1 << 1,
  ENUMERABLE: 1 << 2,
  C_W_E: (1 << 0) | (1 << 1) | (1 << 2),
  LENGTH: 1 << 3,
  TMASK: 3 << 4,
  NORMAL: 0 << 4,
  GETSET: 1 << 4,
  VARREF: 2 << 4,
  AUTOINIT: 3 << 4,
  HAS_SHIFT: 8,
  HAS_CONFIGURABLE: 1 << 8,
  HAS_WRITABLE: 1 << 9,
  HAS_ENUMERABLE: 1 << 10,
  HAS_GET: 1 << 11,
  HAS_SET: 1 << 12,
  HAS_VALUE: 1 << 13,
  THROW: 1 << 14,
  THROW_STRICT: 1 << 15,
  NO_EXOTIC: 1 << 16,
} as const;

export const QuickJSGetOwnPropertyNamesFlags = {
  STRING_MASK: 1 << 0,
  SYMBOL_MASK: 1 << 1,
  PRIVATE_MASK: 1 << 2,
  ENUM_ONLY: 1 << 4,
  SET_ENUM: 1 << 5,
} as const;

export const QuickJSTypedArray = {
  UINT8C: 0,
  INT8: 1,
  UINT8: 2,
  INT16: 3,
  UINT16: 4,
  INT32: 5,
  UINT32: 6,
  BIG_INT64: 7,
  BIG_UINT64: 8,
  FLOAT16: 9,
  FLOAT32: 10,
  FLOAT64: 11,
} as const;

export const QuickJSPromiseState = {
  NOT_PROMISE: -1,
  PENDING: 0,
  FULFILLED: 1,
  REJECTED: 2,
} as const;
export type QuickJSPromiseStateValue =
  (typeof QuickJSPromiseState)[keyof typeof QuickJSPromiseState];

export const QuickJSParseJsonFlags = {
  EXT: 1 << 0,
} as const;

export const QuickJSWriteObjectFlags = {
  BYTECODE: 1 << 0,
  BSWAP: 1 << 1,
  SAB: 1 << 2,
  REFERENCE: 1 << 3,
} as const;

export const QuickJSReadObjectFlags = {
  BYTECODE: 1 << 0,
  ROM_DATA: 1 << 1,
  SAB: 1 << 2,
  REFERENCE: 1 << 3,
} as const;

export const QuickJSStripFlags = {
  SOURCE: 1 << 0,
  DEBUG: 1 << 1,
} as const;

export const QuickJSCallFlags = {
  CONSTRUCTOR: 1 << 0,
} as const;

export const QuickJSAtom = {
  NULL: 0,
} as const;

export const QUICKJS_DEFAULT_STACK_SIZE = 1024 * 1024;

export const QuickJSCFunction = {
  GENERIC: 0,
  GENERIC_MAGIC: 1,
  CONSTRUCTOR: 2,
  CONSTRUCTOR_MAGIC: 3,
  CONSTRUCTOR_OR_FUNC: 4,
  CONSTRUCTOR_OR_FUNC_MAGIC: 5,
  F_F: 6,
  F_F_F: 7,
  GETTER: 8,
  SETTER: 9,
  GETTER_MAGIC: 10,
  SETTER_MAGIC: 11,
  ITERATOR_NEXT: 12,
} as const;

export const QuickJSFunctionListEntry = {
  C_FUNC: 0,
  C_GETSET: 1,
  C_GETSET_MAGIC: 2,
  PROP_STRING: 3,
  PROP_INT32: 4,
  PROP_INT64: 5,
  PROP_DOUBLE: 6,
  PROP_UNDEFINED: 7,
  OBJECT: 8,
  ALIAS: 9,
  PROP_ATOM: 10,
  PROP_BOOL: 11,
} as const;

export const QuickJSClassId = {
  INVALID: 0,
} as const;

const nativeSymbols = {
  JS_NewRuntime: fn([], "ptr"),
  JS_NewRuntime2: fn(["ptr", "ptr"], "ptr"),
  JS_FreeRuntime: voidFn(["ptr"]),
  JS_SetRuntimeInfo: voidFn(["ptr", "buffer"]),
  JS_SetMemoryLimit: voidFn(["ptr", usize]),
  JS_SetGCThreshold: voidFn(["ptr", usize]),
  JS_SetMaxStackSize: voidFn(["ptr", usize]),
  JS_UpdateStackTop: voidFn(["ptr"]),
  JS_RunGC: voidFn(["ptr"]),
  JS_SetRuntimeOpaque: voidFn(["ptr", "ptr"]),
  JS_GetRuntimeOpaque: fn(["ptr"], "ptr"),
  JS_ComputeMemoryUsage: voidFn(["ptr", "buffer"]),
  JS_NewContext: fn(["ptr"], "ptr"),
  JS_NewContextRaw: fn(["ptr"], "ptr"),
  JS_FreeContext: voidFn(["ptr"]),
  JS_DupContext: fn(["ptr"], "ptr"),
  JS_GetRuntime: fn(["ptr"], "ptr"),
  JS_SetContextOpaque: voidFn(["ptr", "ptr"]),
  JS_GetContextOpaque: fn(["ptr"], "ptr"),
  JS_AddIntrinsicBaseObjects: fn(["ptr"], "i32"),
  JS_AddIntrinsicDate: fn(["ptr"], "i32"),
  JS_AddIntrinsicEval: fn(["ptr"], "i32"),
  JS_AddIntrinsicStringNormalize: fn(["ptr"], "i32"),
  JS_AddIntrinsicRegExpCompiler: voidFn(["ptr"]),
  JS_AddIntrinsicRegExp: fn(["ptr"], "i32"),
  JS_AddIntrinsicJSON: fn(["ptr"], "i32"),
  JS_AddIntrinsicProxy: fn(["ptr"], "i32"),
  JS_AddIntrinsicMapSet: fn(["ptr"], "i32"),
  JS_AddIntrinsicTypedArrays: fn(["ptr"], "i32"),
  JS_AddIntrinsicPromise: fn(["ptr"], "i32"),
  JS_AddIntrinsicWeakRef: fn(["ptr"], "i32"),
  JS_NewClassID: fn(["buffer"], "u32"),
  JS_NewClass: fn(["ptr", "u32", "ptr"], "i32"),
  JS_IsRegisteredClass: fn(["ptr", "u32"], "i32"),
  JS_NewAtomLen: fn(["ptr", "buffer", usize], "u32"),
  JS_NewAtom: fn(["ptr", "buffer"], "u32"),
  JS_NewAtomUInt32: fn(["ptr", "u32"], "u32"),
  JS_DupAtom: fn(["ptr", "u32"], "u32"),
  JS_FreeAtom: voidFn(["ptr", "u32"]),
  JS_FreeAtomRT: voidFn(["ptr", "u32"]),
  JS_AtomToCStringLen: fn(["ptr", "ptr", "u32"], "ptr"),
  JS_FreeCString: voidFn(["ptr", "ptr"]),
  JS_FreePropertyEnum: voidFn(["ptr", "ptr", "u32"]),
  JS_DetectModule: fn(["buffer", usize], "i32"),
  JS_SetUncatchableException: voidFn(["ptr", "i32"]),
  JS_HasException: fn(["ptr"], "i32"),
  JS_SetCanBlock: voidFn(["ptr", "i32"]),
  JS_SetStripInfo: voidFn(["ptr", "i32"]),
  JS_GetStripInfo: fn(["ptr"], "i32"),
  JS_IsJobPending: fn(["ptr"], "i32"),
  JS_ExecutePendingJob: fn(["ptr", "buffer"], "i32"),
  JS_SetSharedArrayBufferFunctions: voidFn(["ptr", "ptr"]),
  JS_SetHostPromiseRejectionTracker: voidFn(["ptr", "ptr", "ptr"]),
  JS_SetInterruptHandler: voidFn(["ptr", "ptr", "ptr"]),
  JS_SetModuleLoaderFunc: voidFn(["ptr", "ptr", "ptr", "ptr"]),
  JS_SetModuleLoaderFunc2: voidFn(["ptr", "ptr", "ptr", "ptr", "ptr"]),
  JS_GetScriptOrModuleName: fn(["ptr", "i32"], "u32"),
  JS_GetModuleName: fn(["ptr", "ptr"], "u32"),
  JS_EnqueueJob: fn(["ptr", "ptr", "i32", "buffer"], "i32"),
  JS_NewCModule: fn(["ptr", "buffer", "ptr"], "ptr"),
  JS_AddModuleExport: fn(["ptr", "ptr", "buffer"], "i32"),
  JS_AddModuleExportList: fn(["ptr", "ptr", "ptr", "i32"], "i32"),
  JS_SetModuleExportList: fn(["ptr", "ptr", "ptr", "i32"], "i32"),
  JS_PrintValueSetDefaultOptions: voidFn(["buffer"]),
  js_malloc_rt: fn(["ptr", usize], "ptr"),
  js_free_rt: voidFn(["ptr", "ptr"]),
  js_realloc_rt: fn(["ptr", "ptr", usize], "ptr"),
  js_malloc_usable_size_rt: fn(["ptr", "ptr"], "u64"),
  js_mallocz_rt: fn(["ptr", usize], "ptr"),
  js_malloc: fn(["ptr", usize], "ptr"),
  js_free: voidFn(["ptr", "ptr"]),
  js_realloc: fn(["ptr", "ptr", usize], "ptr"),
  js_malloc_usable_size: fn(["ptr", "ptr"], "u64"),
  js_realloc2: fn(["ptr", "ptr", usize, "buffer"], "ptr"),
  js_mallocz: fn(["ptr", usize], "ptr"),
  js_strdup: fn(["ptr", "buffer"], "ptr"),
  js_strndup: fn(["ptr", "buffer", usize], "ptr"),
  JS_DumpMemoryUsage: voidFn(["ptr", "buffer", "ptr"]),

  qjs_bun_new_class: fn(["ptr", "u32", "buffer"], "i32"),
  qjs_bun_init_host_slot_class: fn(["ptr"], "i32"),
  qjs_bun_set_host_slot_finalizer: voidFn(["ptr"]),
  qjs_bun_compile_module: fn(["ptr", "buffer", usize, "buffer"], "ptr"),
  qjs_bun_dump_memory_usage: fn(["ptr", "buffer"], "ptr"),
  qjs_bun_set_module_loader_func2: voidFn(["ptr", "ptr"]),
  qjs_bun_set_host_promise_rejection_tracker: voidFn(["ptr", "ptr"]),
  qjs_bun_eval: voidFn(["ptr", "buffer", "buffer", usize, "buffer", "i32"]),
  qjs_bun_eval_this: voidFn(["ptr", "buffer", "ptr", "buffer", usize, "buffer", "i32"]),
  qjs_bun_call: voidFn(["ptr", "buffer", "ptr", "ptr", "u32", "ptr"]),
  qjs_bun_invoke: voidFn(["ptr", "buffer", "ptr", "u32", "u32", "ptr"]),
  qjs_bun_call_constructor: voidFn(["ptr", "buffer", "ptr", "u32", "ptr"]),
  qjs_bun_call_constructor2: voidFn(["ptr", "buffer", "ptr", "ptr", "u32", "ptr"]),
  qjs_bun_string_code_point_range: voidFn(["ptr", "buffer", "ptr", "u32", "ptr"]),
  qjs_bun_get_exception: voidFn(["ptr", "buffer"]),
  qjs_bun_get_global: voidFn(["ptr", "buffer"]),
  qjs_bun_new_string: voidFn(["ptr", "buffer", "buffer"]),
  qjs_bun_new_string_len: voidFn(["ptr", "buffer", usize, "buffer"]),
  qjs_bun_new_object: voidFn(["ptr", "buffer"]),
  qjs_bun_new_array: voidFn(["ptr", "buffer"]),
  qjs_bun_new_error: voidFn(["ptr", "buffer"]),
  qjs_bun_new_promise: voidFn(["ptr", "buffer", "buffer"]),
  qjs_bun_throw: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_get_data_property: voidFn(["ptr", "ptr", "u32", "buffer"]),
  qjs_bun_get_property_str: voidFn(["ptr", "ptr", "buffer", "buffer"]),
  qjs_bun_get_property_u32: voidFn(["ptr", "ptr", "u32", "buffer"]),
  qjs_bun_promise_result: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_read_object: voidFn(["ptr", "buffer", usize, "i32", "buffer"]),
  qjs_bun_throw_syntax_error: voidFn(["ptr", "buffer", "buffer"]),
  qjs_bun_throw_type_error: voidFn(["ptr", "buffer", "buffer"]),
  qjs_bun_throw_reference_error: voidFn(["ptr", "buffer", "buffer"]),
  qjs_bun_throw_range_error: voidFn(["ptr", "buffer", "buffer"]),
  qjs_bun_throw_internal_error: voidFn(["ptr", "buffer", "buffer"]),
  qjs_bun_throw_out_of_memory: voidFn(["ptr", "buffer"]),
  qjs_bun_new_bool: voidFn(["ptr", "i32", "buffer"]),
  qjs_bun_new_catch_offset: voidFn(["ptr", "i32", "buffer"]),
  qjs_bun_new_int32: voidFn(["ptr", "i32", "buffer"]),
  qjs_bun_new_int64: voidFn(["ptr", "i64", "buffer"]),
  qjs_bun_new_uint32: voidFn(["ptr", "i32", "buffer"]),
  qjs_bun_new_float64: voidFn(["ptr", "f64", "buffer"]),
  qjs_bun_new_bigint64: voidFn(["ptr", "i64", "buffer"]),
  qjs_bun_new_biguint64: voidFn(["ptr", "u64", "buffer"]),
  qjs_bun_new_atom_string: voidFn(["ptr", "buffer", "buffer"]),
  qjs_bun_atom_to_value: voidFn(["ptr", "u32", "buffer"]),
  qjs_bun_atom_to_string: voidFn(["ptr", "u32", "buffer"]),
  qjs_bun_to_string: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_to_property_key: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_get_class_proto: voidFn(["ptr", "u32", "buffer"]),
  qjs_bun_new_object_proto: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_new_object_class: voidFn(["ptr", "i32", "buffer"]),
  qjs_bun_new_object_proto_class: voidFn(["ptr", "ptr", "i32", "buffer"]),
  qjs_bun_new_date: voidFn(["ptr", "buffer", "buffer"]),
  qjs_bun_get_property: voidFn(["ptr", "ptr", "u32", "buffer"]),
  qjs_bun_get_property_internal: voidFn(["ptr", "ptr", "u32", "ptr", "i32", "buffer"]),
  qjs_bun_get_prototype: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_parse_json: voidFn(["ptr", "buffer", "buffer", usize, "buffer"]),
  qjs_bun_parse_json2: voidFn(["ptr", "buffer", "buffer", usize, "buffer", "i32"]),
  qjs_bun_json_stringify: voidFn(["ptr", "buffer", "ptr", "ptr", "ptr"]),
  qjs_bun_new_array_buffer: voidFn(["ptr", "buffer", "ptr", usize, "ptr", "ptr", "i32"]),
  qjs_bun_new_array_buffer_copy: voidFn(["ptr", "buffer", "buffer", usize]),
  qjs_bun_new_typed_array: voidFn(["ptr", "buffer", "i32", "ptr", "i32"]),
  qjs_bun_get_typed_array_buffer: voidFn(["ptr", "ptr", "ptr", "ptr", "ptr", "buffer"]),
  qjs_bun_get_import_meta: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_get_module_namespace: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_load_module: voidFn(["ptr", "buffer", "buffer", "buffer"]),
  qjs_bun_eval_function: voidFn(["ptr", "buffer", "ptr"]),
  qjs_bun_new_c_function: voidFn(["ptr", "ptr", "buffer", "i32", "buffer"]),
  qjs_bun_new_c_function_magic: voidFn(["ptr", "ptr", "buffer", "i32", "i32", "i32", "buffer"]),
  qjs_bun_new_c_function2: voidFn(["ptr", "ptr", "buffer", "i32", "i32", "i32", "buffer"]),
  qjs_bun_new_c_function_data: voidFn(["ptr", "buffer", "ptr", "i32", "i32", "i32", "ptr"]),
  qjs_bun_get_module_private_value: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_get_own_property_names: fn(["ptr", "buffer", "buffer", "ptr", "i32"], "i32"),
  qjs_bun_get_own_property: fn(["ptr", "buffer", "ptr", "u32"], "i32"),
  qjs_bun_is_number: fn(["ptr"], "i32"),
  qjs_bun_is_bigint: fn(["ptr", "ptr"], "i32"),
  qjs_bun_is_bool: fn(["ptr"], "i32"),
  qjs_bun_is_null: fn(["ptr"], "i32"),
  qjs_bun_is_undefined: fn(["ptr"], "i32"),
  qjs_bun_is_exception: fn(["ptr"], "i32"),
  qjs_bun_is_uninitialized: fn(["ptr"], "i32"),
  qjs_bun_is_string: fn(["ptr"], "i32"),
  qjs_bun_is_symbol: fn(["ptr"], "i32"),
  qjs_bun_is_object: fn(["ptr"], "i32"),
  qjs_bun_is_live_object: fn(["ptr", "ptr"], "i32"),
  qjs_bun_is_array: fn(["ptr", "ptr"], "i32"),
  qjs_bun_is_error: fn(["ptr", "ptr"], "i32"),
  qjs_bun_is_function: fn(["ptr", "ptr"], "i32"),
  qjs_bun_is_constructor: fn(["ptr", "ptr"], "i32"),
  qjs_bun_is_instance_of: fn(["ptr", "ptr", "ptr"], "i32"),
  qjs_bun_promise_state: fn(["ptr", "ptr"], "i32"),
  qjs_bun_set_property_str: fn(["ptr", "ptr", "buffer", "ptr"], "i32"),
  qjs_bun_set_property_u32: fn(["ptr", "ptr", "u32", "ptr"], "i32"),
  qjs_bun_set_property: fn(["ptr", "ptr", "u32", "ptr"], "i32"),
  qjs_bun_set_property_internal: fn(["ptr", "ptr", "u32", "ptr", "ptr", "i32"], "i32"),
  qjs_bun_set_property_i64: fn(["ptr", "ptr", "i64", "ptr"], "i32"),
  qjs_bun_has_property: fn(["ptr", "ptr", "u32"], "i32"),
  qjs_bun_delete_property: fn(["ptr", "ptr", "u32", "i32"], "i32"),
  qjs_bun_is_extensible: fn(["ptr", "ptr"], "i32"),
  qjs_bun_prevent_extensions: fn(["ptr", "ptr"], "i32"),
  qjs_bun_set_prototype: fn(["ptr", "ptr", "ptr"], "i32"),
  qjs_bun_set_constructor_bit: fn(["ptr", "ptr", "i32"], "i32"),
  qjs_bun_set_constructor: fn(["ptr", "ptr", "ptr"], "i32"),
  qjs_bun_strict_eq: fn(["ptr", "ptr", "ptr"], "i32"),
  qjs_bun_same_value: fn(["ptr", "ptr", "ptr"], "i32"),
  qjs_bun_same_value_zero: fn(["ptr", "ptr", "ptr"], "i32"),
  qjs_bun_to_int32: fn(["ptr", "buffer", "ptr"], "i32"),
  qjs_bun_to_uint32: fn(["ptr", "buffer", "ptr"], "i32"),
  qjs_bun_to_int64: fn(["ptr", "buffer", "ptr"], "i32"),
  qjs_bun_to_index: fn(["ptr", "buffer", "ptr"], "i32"),
  qjs_bun_to_bigint64: fn(["ptr", "buffer", "ptr"], "i32"),
  qjs_bun_to_int64_ext: fn(["ptr", "buffer", "ptr"], "i32"),
  qjs_bun_define_property: fn(["ptr", "ptr", "u32", "ptr", "ptr", "ptr", "i32"], "i32"),
  qjs_bun_define_property_value: fn(["ptr", "ptr", "u32", "ptr", "i32"], "i32"),
  qjs_bun_define_property_value_u32: fn(["ptr", "ptr", "u32", "ptr", "i32"], "i32"),
  qjs_bun_define_property_value_str: fn(["ptr", "ptr", "buffer", "ptr", "i32"], "i32"),
  qjs_bun_define_property_get_set: fn(["ptr", "ptr", "u32", "ptr", "ptr", "i32"], "i32"),
  qjs_bun_resolve_module: fn(["ptr", "ptr"], "i32"),
  qjs_bun_set_property_function_list: fn(["ptr", "ptr", "ptr", "i32"], "i32"),
  qjs_bun_set_module_export: fn(["ptr", "ptr", "buffer", "ptr"], "i32"),
  qjs_bun_set_module_private_value: fn(["ptr", "ptr", "ptr"], "i32"),
  qjs_bun_to_bool: fn(["ptr", "ptr"], "i32"),
  qjs_bun_to_float64: fn(["ptr", "buffer", "ptr"], "i32"),
  qjs_bun_get_class_id: fn(["ptr"], "u32"),
  qjs_bun_value_to_atom: fn(["ptr", "ptr"], "u32"),
  qjs_bun_value_get_norm_tag: fn(["ptr"], "i32"),
  qjs_bun_value_is_nan: fn(["ptr"], "i32"),
  qjs_bun_value_get_float64: fn(["ptr"], "f64"),
  qjs_bun_to_cstring: fn(["ptr", "ptr"], "ptr"),
  qjs_bun_to_cstring_len: fn(["ptr", "buffer", "ptr"], "ptr"),
  qjs_bun_to_cstring_len2: fn(["ptr", "buffer", "ptr", "i32"], "ptr"),
  qjs_bun_get_opaque: fn(["ptr", "u32"], "ptr"),
  qjs_bun_get_opaque2: fn(["ptr", "ptr", "u32"], "ptr"),
  qjs_bun_get_any_opaque: fn(["ptr", "buffer"], "ptr"),
  qjs_bun_get_array_buffer: fn(["ptr", "buffer", "ptr"], "ptr"),
  qjs_bun_write_object: fn(["ptr", "buffer", "ptr", "i32"], "ptr"),
  qjs_bun_write_object2: fn(["ptr", "buffer", "ptr", "i32", "ptr", "ptr"], "ptr"),
  qjs_bun_js_module_set_import_meta: fn(["ptr", "ptr", "i32", "i32"], "i32"),
  qjs_bun_new_host_function: voidFn(["ptr", "ptr", "i32", "buffer"]),
  qjs_bun_enqueue_host_job: fn(["ptr", "ptr", "i32", "u32", "ptr"], "i32"),
  qjs_bun_mark_value: voidFn(["ptr", "ptr", "ptr"]),
  qjs_bun_set_class_proto: voidFn(["ptr", "u32", "ptr"]),
  qjs_bun_free_value: voidFn(["ptr", "ptr"]),
  qjs_bun_free_value_rt: voidFn(["ptr", "ptr"]),
  qjs_bun_detach_array_buffer: voidFn(["ptr", "ptr"]),
  qjs_bun_set_is_html_dda: voidFn(["ptr", "ptr"]),
  qjs_bun_set_opaque: voidFn(["ptr", "ptr"]),
  qjs_bun_print_value_rt: voidFn(["ptr", "ptr", "ptr", "ptr", "ptr"]),
  qjs_bun_print_value: voidFn(["ptr", "ptr", "ptr", "ptr", "ptr"]),
  qjs_bun_print_value_options: voidFn([
    "ptr",
    "ptr",
    "ptr",
    "ptr",
    "i32",
    "i32",
    "u32",
    "u32",
    "u32",
  ]),
  qjs_bun_dup_value: voidFn(["ptr", "ptr", "buffer"]),
  qjs_bun_dup_value_rt: voidFn(["ptr", "ptr", "buffer"]),
};

function openNative(path: QuickJSPath | undefined) {
  if (path) return dlopen(path, nativeSymbols);
  if (process.platform === "win32") {
    throw new Error("quickjs-bun on Windows requires a manually built native library path.");
  }
  return cc({
    // NOTE(kenta): Bun supports a list of source files.
    source: quickJSSources as unknown as string,
    include: nativeInclude,
    library: quickJSLibraries,
    define: {
      CONFIG_VERSION: `"${QUICKJS_VERSION_TEXT}"`,
      NDEBUG: "1",
      _GNU_SOURCE: "1",
    },
    symbols: nativeSymbols,
  });
}

type QuickJSNativeLibrary = Library<typeof nativeSymbols>;
export type QuickJSNative = QuickJSNativeLibrary["symbols"];

export class QuickJS {
  readonly native: QuickJSNative;
  #library: QuickJSNativeLibrary;
  #closed = false;
  #runtimes = new Map<string, JSRuntime>();
  #hostSlotFinalizerCallback?: JSCallback;

  constructor(options: QuickJSOptions = {}) {
    this.#library = openNative(options.path ?? process.env.QUICKJS_BUN_NATIVE_LIBRARY);
    this.native = this.#library.symbols;
  }

  registerRuntime(runtime: JSRuntime): void {
    this.#runtimes.set(String(runtime.ptr), runtime);
  }

  unregisterRuntime(runtime: JSRuntime): void {
    this.#runtimes.delete(String(runtime.ptr));
  }

  ensureHostSlotFinalizer(): void {
    if (this.#hostSlotFinalizerCallback) return;
    this.#hostSlotFinalizerCallback = new JSCallback(
      (rtPtr: Pointer | null, ctxPtr: Pointer | null, hostId: number) => {
        if (rtPtr === null || ctxPtr === null) return;
        const runtime = this.#runtimes.get(String(rtPtr));
        runtime?.dispatchHostSlotFinalize(ctxPtr, hostId);
      },
      { args: ["ptr", "ptr", "u32"], returns: "void" },
    );
    if (this.#hostSlotFinalizerCallback.ptr === null) {
      throw new Error("Host slot finalizer callback pointer is null");
    }
    this.native.qjs_bun_set_host_slot_finalizer(this.#hostSlotFinalizerCallback.ptr);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#hostSlotFinalizerCallback) {
      this.native.qjs_bun_set_host_slot_finalizer(null);
      this.#hostSlotFinalizerCallback.close();
      this.#hostSlotFinalizerCallback = undefined;
    }
    this.#library.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
