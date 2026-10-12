import { cc, dlopen, FFIType, linkSymbols, type FFIFunction, type Library } from "bun:ffi";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { JSBytes } from "./types";

export const QUICKJS_VERSION_TEXT = readFileSync(
  new URL("../quickjs/VERSION", import.meta.url),
  "utf8",
).trim();
export const QUICKJS_VALUE_CELL_BYTES = 16;
export const QUICKJS_DEFAULT_STACK_SIZE = 1024 * 1024;

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

export const QuickJSPrimitiveHint = {
  STRING: 0,
  NUMBER: 1,
  NONE: 2,
} as const;

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
  TAG_INT: 0x80000000,
  MAX_INT: 0x7fffffff,
} as const;

export const QuickJSClassId = {
  INVALID: 0,
} as const;

export const encoder = new TextEncoder();

export function cstring(text: string): Uint8Array {
  assert(!text.includes("\0"), "string must not contain a NUL character");
  return encoder.encode(`${text}\0`);
}

export function bytes(view: JSBytes): Uint8Array {
  if (!ArrayBuffer.isView(view)) return new Uint8Array(view);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

const symbols = {
  JS_NewRuntime: { args: [], returns: "ptr" },
  JS_FreeRuntime: { args: ["ptr"], returns: "void" },
  qjs_bun_new_runtime: { args: [], returns: "ptr" },
  qjs_bun_free_runtime: { args: ["ptr"], returns: "void" },
  JS_SetRuntimeInfo: { args: ["ptr", "buffer"], returns: "void" },
  JS_SetMemoryLimit: { args: ["ptr", "u64"], returns: "void" },
  JS_SetGCThreshold: { args: ["ptr", "u64"], returns: "void" },
  JS_SetMaxStackSize: { args: ["ptr", "u64"], returns: "void" },
  JS_UpdateStackTop: { args: ["ptr"], returns: "void" },
  JS_RunGC: { args: ["ptr"], returns: "void" },
  JS_SetRuntimeOpaque: { args: ["ptr", "ptr"], returns: "void" },
  JS_GetRuntimeOpaque: { args: ["ptr"], returns: "ptr" },
  JS_ComputeMemoryUsage: { args: ["ptr", "buffer"], returns: "void" },
  qjs_bun_dump_memory_usage: { args: ["ptr", "buffer"], returns: "ptr" },
  JS_SetCanBlock: { args: ["ptr", "i32"], returns: "void" },
  JS_SetStripInfo: { args: ["ptr", "i32"], returns: "void" },
  JS_GetStripInfo: { args: ["ptr"], returns: "i32" },
  JS_IsJobPending: { args: ["ptr"], returns: "i32" },
  qjs_bun_execute_pending_job: { args: ["ptr", "f64", "buffer"], returns: "i32" },
  JS_NewClassID: { args: ["buffer"], returns: "u32" },
  JS_NewClass: { args: ["ptr", "u32", "ptr"], returns: "i32" },
  qjs_bun_new_class: { args: ["ptr", "u32", "buffer", "ptr"], returns: "i32" },
  JS_IsRegisteredClass: { args: ["ptr", "u32"], returns: "i32" },
  qjs_bun_set_module_loader: { args: ["ptr", "ptr", "ptr"], returns: "void" },
  qjs_bun_set_promise_rejection_tracker: { args: ["ptr", "ptr"], returns: "void" },
  JS_SetSharedArrayBufferFunctions: { args: ["ptr", "ptr"], returns: "void" },
  JS_FreeAtomRT: { args: ["ptr", "u32"], returns: "void" },
  qjs_bun_dup_value_rt: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_free_value_rt: { args: ["ptr", "ptr"], returns: "void" },
  qjs_bun_is_live_object: { args: ["ptr", "ptr"], returns: "i32" },
  JS_NewContext: { args: ["ptr"], returns: "ptr" },
  JS_NewContextRaw: { args: ["ptr"], returns: "ptr" },
  JS_FreeContext: { args: ["ptr"], returns: "void" },
  JS_DupContext: { args: ["ptr"], returns: "ptr" },
  JS_GetRuntime: { args: ["ptr"], returns: "ptr" },
  qjs_bun_new_context: { args: ["ptr", "i32", "f64"], returns: "ptr" },
  qjs_bun_free_context: { args: ["ptr"], returns: "void" },
  JS_SetContextOpaque: { args: ["ptr", "ptr"], returns: "void" },
  JS_GetContextOpaque: { args: ["ptr"], returns: "ptr" },
  qjs_bun_add_intrinsic: { args: ["ptr", "i32"], returns: "i32" },
  JS_AddIntrinsicBaseObjects: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicDate: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicEval: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicStringNormalize: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicRegExpCompiler: { args: ["ptr"], returns: "void" },
  JS_AddIntrinsicRegExp: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicJSON: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicProxy: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicMapSet: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicTypedArrays: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicPromise: { args: ["ptr"], returns: "i32" },
  JS_AddIntrinsicWeakRef: { args: ["ptr"], returns: "i32" },
  qjs_bun_get_global: { args: ["ptr", "buffer"], returns: "void" },
  qjs_bun_get_class_proto: { args: ["ptr", "buffer", "u32"], returns: "void" },
  qjs_bun_set_class_proto: { args: ["ptr", "u32", "ptr"], returns: "void" },
  JS_GetScriptOrModuleName: { args: ["ptr", "i32"], returns: "u32" },
  qjs_bun_eval: {
    args: ["ptr", "buffer", "ptr", "buffer", "u64", "buffer", "i32", "f64"],
    returns: "void",
  },
  qjs_bun_eval_function: { args: ["ptr", "buffer", "ptr", "f64"], returns: "void" },
  qjs_bun_call: { args: ["ptr", "buffer", "ptr", "ptr", "u32", "ptr", "f64"], returns: "void" },
  qjs_bun_invoke: { args: ["ptr", "buffer", "ptr", "u32", "u32", "ptr", "f64"], returns: "void" },
  qjs_bun_call_constructor: {
    args: ["ptr", "buffer", "ptr", "ptr", "u32", "ptr", "f64"],
    returns: "void",
  },
  JS_DetectModule: { args: ["buffer", "u64"], returns: "i32" },
  qjs_bun_parse_json: {
    args: ["ptr", "buffer", "buffer", "u64", "buffer", "i32"],
    returns: "void",
  },
  qjs_bun_json_stringify: { args: ["ptr", "buffer", "ptr", "ptr", "ptr"], returns: "void" },
  qjs_bun_read_object: { args: ["ptr", "buffer", "buffer", "u64", "i32"], returns: "void" },
  qjs_bun_write_object: { args: ["ptr", "buffer", "ptr", "i32"], returns: "ptr" },
  qjs_bun_write_object2: { args: ["ptr", "buffer", "ptr", "i32", "ptr", "ptr"], returns: "ptr" },
  qjs_bun_get_exception: { args: ["ptr", "buffer"], returns: "void" },
  JS_HasException: { args: ["ptr"], returns: "i32" },
  qjs_bun_throw: { args: ["ptr", "ptr", "ptr"], returns: "void" },
  qjs_bun_throw_error: { args: ["ptr", "i32", "buffer"], returns: "void" },
  qjs_bun_throw_out_of_memory: { args: ["ptr", "ptr"], returns: "void" },
  JS_SetUncatchableException: { args: ["ptr", "i32"], returns: "void" },
  qjs_bun_dup_value: { args: ["ptr", "ptr", "ptr"], returns: "void" },
  qjs_bun_free_value: { args: ["ptr", "ptr"], returns: "void" },
  qjs_bun_type: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_get_class_id: { args: ["ptr"], returns: "u32" },
  qjs_bun_new_string_len: { args: ["ptr", "buffer", "buffer", "u64"], returns: "void" },
  qjs_bun_to_cstring_copy: { args: ["ptr", "ptr", "buffer", "u64"], returns: FFIType.i64_fast },
  qjs_bun_to_cstring_len: { args: ["ptr", "buffer", "ptr", "i32"], returns: "ptr" },
  JS_FreeCString: { args: ["ptr", "ptr"], returns: "void" },
  qjs_bun_new_bigint64: { args: ["ptr", "buffer", "i64"], returns: "void" },
  qjs_bun_new_biguint64: { args: ["ptr", "buffer", "u64"], returns: "void" },
  qjs_bun_new_bigint128: { args: ["ptr", "buffer", "u64", "u64"], returns: "void" },
  qjs_bun_to_bigint128: { args: ["ptr", "buffer", "buffer", "ptr"], returns: "i32" },
  qjs_bun_new_symbol: { args: ["ptr", "buffer", "buffer", "i32"], returns: "void" },
  qjs_bun_new_object: { args: ["ptr", "buffer"], returns: "void" },
  qjs_bun_new_object_proto: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_new_object_class: { args: ["ptr", "buffer", "i32"], returns: "void" },
  qjs_bun_new_object_proto_class: { args: ["ptr", "buffer", "ptr", "i32"], returns: "void" },
  qjs_bun_new_array: { args: ["ptr", "buffer"], returns: "void" },
  qjs_bun_new_date: { args: ["ptr", "buffer", "f64"], returns: "void" },
  qjs_bun_date_value: { args: ["ptr", "buffer", "ptr"], returns: "i32" },
  qjs_bun_new_error: { args: ["ptr", "buffer"], returns: "void" },
  qjs_bun_new_promise: { args: ["ptr", "buffer", "buffer"], returns: "void" },
  qjs_bun_promise_state: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_promise_result: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_new_host_function: { args: ["ptr", "buffer", "ptr", "u32"], returns: "void" },
  qjs_bun_enqueue_job: { args: ["ptr", "u32", "ptr"], returns: "i32" },
  qjs_bun_new_atom_string: { args: ["ptr", "buffer", "buffer"], returns: "void" },
  qjs_bun_to_object: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_to_primitive: { args: ["ptr", "buffer", "ptr", "i32"], returns: "void" },
  qjs_bun_to_string: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_to_property_key: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_to_bool: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_to_float64: { args: ["ptr", "buffer", "ptr"], returns: "i32" },
  qjs_bun_to_int32: { args: ["ptr", "buffer", "ptr"], returns: "i32" },
  qjs_bun_to_int32_sat: { args: ["ptr", "buffer", "ptr"], returns: "i32" },
  qjs_bun_to_uint32: { args: ["ptr", "buffer", "ptr"], returns: "i32" },
  qjs_bun_to_int64: { args: ["ptr", "buffer", "ptr"], returns: "i32" },
  qjs_bun_to_int64_ext: { args: ["ptr", "buffer", "ptr"], returns: "i32" },
  qjs_bun_to_index: { args: ["ptr", "buffer", "ptr"], returns: "i32" },
  qjs_bun_to_bigint64: { args: ["ptr", "buffer", "ptr"], returns: "i32" },
  qjs_bun_strict_eq: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  qjs_bun_same_value: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  qjs_bun_same_value_zero: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  qjs_bun_is_function: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_is_constructor: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_is_array: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_is_error: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_is_instance_of: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  qjs_bun_ordinary_is_instance_of: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  qjs_bun_set_constructor_bit: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  qjs_bun_set_constructor: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  qjs_bun_set_is_html_dda: { args: ["ptr", "ptr"], returns: "void" },
  qjs_bun_create_from_constructor: { args: ["ptr", "buffer", "ptr", "i32"], returns: "void" },
  qjs_bun_get_property: { args: ["ptr", "buffer", "ptr", "u32"], returns: "void" },
  qjs_bun_get_property_internal: {
    args: ["ptr", "buffer", "ptr", "u32", "ptr", "i32"],
    returns: "void",
  },
  qjs_bun_get_data_property: { args: ["ptr", "ptr", "u32", "buffer"], returns: "void" },
  qjs_bun_get_property_u32: { args: ["ptr", "buffer", "ptr", "u32"], returns: "void" },
  qjs_bun_set_property: { args: ["ptr", "ptr", "u32", "ptr"], returns: "i32" },
  qjs_bun_set_property_internal: {
    args: ["ptr", "ptr", "u32", "ptr", "ptr", "i32"],
    returns: "i32",
  },
  qjs_bun_set_property_u32: { args: ["ptr", "ptr", "u32", "ptr"], returns: "i32" },
  qjs_bun_set_property_i64: { args: ["ptr", "ptr", "i64", "ptr"], returns: "i32" },
  qjs_bun_has_property: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  qjs_bun_delete_property: { args: ["ptr", "ptr", "u32", "i32"], returns: "i32" },
  qjs_bun_define_property: {
    args: ["ptr", "ptr", "u32", "ptr", "ptr", "ptr", "i32"],
    returns: "i32",
  },
  qjs_bun_define_property_value: { args: ["ptr", "ptr", "u32", "ptr", "i32"], returns: "i32" },
  qjs_bun_define_property_value_u32: { args: ["ptr", "ptr", "u32", "ptr", "i32"], returns: "i32" },
  qjs_bun_define_property_get_set: {
    args: ["ptr", "ptr", "u32", "ptr", "ptr", "i32"],
    returns: "i32",
  },
  qjs_bun_get_own_property: { args: ["ptr", "buffer", "ptr", "u32"], returns: "i32" },
  qjs_bun_get_own_property_names: {
    args: ["ptr", "buffer", "buffer", "ptr", "i32"],
    returns: "i32",
  },
  JS_FreePropertyEnum: { args: ["ptr", "ptr", "u32"], returns: "void" },
  qjs_bun_own_keys: { args: ["ptr", "ptr", "i32", "buffer", "u64"], returns: FFIType.i64_fast },
  qjs_bun_get_prototype: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_set_prototype: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  qjs_bun_is_extensible: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_prevent_extensions: { args: ["ptr", "ptr"], returns: "i32" },
  JS_NewAtomLen: { args: ["ptr", "buffer", "u64"], returns: "u32" },
  JS_NewAtom: { args: ["ptr", "buffer"], returns: "u32" },
  JS_NewAtomUInt32: { args: ["ptr", "u32"], returns: "u32" },
  JS_DupAtom: { args: ["ptr", "u32"], returns: "u32" },
  JS_FreeAtom: { args: ["ptr", "u32"], returns: "void" },
  JS_AtomToCStringLen: { args: ["ptr", "buffer", "u32"], returns: "ptr" },
  qjs_bun_atom_to_value: { args: ["ptr", "buffer", "u32"], returns: "void" },
  qjs_bun_atom_to_string: { args: ["ptr", "buffer", "u32"], returns: "void" },
  qjs_bun_value_to_atom: { args: ["ptr", "ptr"], returns: "u32" },
  qjs_bun_get_opaque: { args: ["ptr", "u32"], returns: "ptr" },
  qjs_bun_get_opaque2: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
  qjs_bun_get_any_opaque: { args: ["ptr", "buffer"], returns: "ptr" },
  qjs_bun_set_opaque: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_new_array_buffer: {
    args: ["ptr", "buffer", "ptr", "u64", "ptr", "u32"],
    returns: "void",
  },
  qjs_bun_new_array_buffer_copy: { args: ["ptr", "buffer", "buffer", "u64"], returns: "void" },
  qjs_bun_get_array_buffer: { args: ["ptr", "buffer", "ptr"], returns: "ptr" },
  qjs_bun_detach_array_buffer: { args: ["ptr", "ptr"], returns: "void" },
  qjs_bun_new_typed_array: { args: ["ptr", "buffer", "u32", "ptr", "i32"], returns: "void" },
  qjs_bun_get_typed_array_buffer: {
    args: ["ptr", "buffer", "ptr", "buffer", "buffer", "buffer"],
    returns: "void",
  },
  qjs_bun_get_iterator: { args: ["ptr", "buffer", "ptr", "i32"], returns: "void" },
  qjs_bun_iterator_next: { args: ["ptr", "buffer", "ptr", "ptr", "buffer"], returns: "void" },
  qjs_bun_iterator_close: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  JS_NewCModule: { args: ["ptr", "buffer", "ptr"], returns: "ptr" },
  JS_AddModuleExport: { args: ["ptr", "ptr", "buffer"], returns: "i32" },
  qjs_bun_set_module_export: { args: ["ptr", "ptr", "buffer", "ptr"], returns: "i32" },
  JS_GetModuleName: { args: ["ptr", "ptr"], returns: "u32" },
  qjs_bun_get_import_meta: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_get_module_namespace: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_get_module_private_value: { args: ["ptr", "buffer", "ptr"], returns: "void" },
  qjs_bun_set_module_private_value: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  qjs_bun_resolve_module: { args: ["ptr", "ptr"], returns: "i32" },
  qjs_bun_load_module: { args: ["ptr", "buffer", "buffer", "buffer"], returns: "void" },
  qjs_bun_compile_module: { args: ["ptr", "buffer", "u64", "buffer"], returns: "ptr" },
  qjs_bun_set_import_meta: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  qjs_bun_print: {
    args: ["ptr", "ptr", "i32", "i32", "u32", "u32", "u32", "buffer"],
    returns: "ptr",
  },
  qjs_bun_timeout_error: { args: ["ptr", "buffer"], returns: "void" },
  qjs_bun_enter_scope: { args: ["ptr", "f64", "buffer"], returns: "void" },
  qjs_bun_leave_scope: { args: ["ptr", "buffer"], returns: "i32" },
  js_malloc: { args: ["ptr", "u64"], returns: "ptr" },
  js_free: { args: ["ptr", "ptr"], returns: "void" },
  js_malloc_rt: { args: ["ptr", "u64"], returns: "ptr" },
  js_free_rt: { args: ["ptr", "ptr"], returns: "void" },
} as const satisfies Record<string, FFIFunction>;

export type QuickJSNative = Library<typeof symbols>["symbols"];
export type QuickJSPath = string | URL;
export interface QuickJSOptions {
  path?: QuickJSPath;
}

export class QuickJS {
  readonly native: QuickJSNative;
  runtimes = 0;
  #library: Library<typeof symbols>;
  #compiled?: Library<{ qjs_bun_symbol: { args: ["buffer"]; returns: "ptr" } }>;
  #closed = false;

  constructor(options: QuickJSOptions = {}) {
    const path = options.path ?? process.env.QUICKJS_BUN_NATIVE_LIBRARY;
    if (path) {
      this.#library = dlopen(path, symbols);
    } else {
      if (process.platform === "win32") {
        throw new Error("quickjs-bun on Windows needs a prebuilt library; see the README");
      }
      const source = (file: string) => Bun.fileURLToPath(new URL(file, import.meta.url));
      this.#compiled = cc({
        source: [
          source("./native/quickjs.c"),
          source("../quickjs/cutils.c"),
          source("../quickjs/libunicode.c"),
          source("../quickjs/libregexp.c"),
          source("../quickjs/dtoa.c"),
          source("./native/alloca.S"),
        ] as unknown as string,
        include: [source("./native/"), source("../quickjs/")],
        library: ["m"],
        flags: ["-w"],
        define: { CONFIG_VERSION: `"${QUICKJS_VERSION_TEXT}"`, NDEBUG: "1", _GNU_SOURCE: "1" },
        symbols: { qjs_bun_symbol: { args: ["buffer"], returns: "ptr" } },
      });
      const linked: Record<string, FFIFunction> = {};
      for (const [name, definition] of Object.entries(symbols)) {
        const address = this.#compiled.symbols.qjs_bun_symbol(cstring(name));
        assert(typeof address === "number", `quickjs-bun is missing the native symbol ${name}`);
        linked[name] = { ...definition, ptr: address };
      }
      this.#library = linkSymbols(linked as unknown as typeof symbols);
    }
    this.native = this.#library.symbols;
  }

  close(): void {
    if (this.#closed) return;
    assert(this.runtimes === 0, "QuickJS library is still used by a runtime");
    this.#closed = true;
    this.#library.close();
    this.#compiled?.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
