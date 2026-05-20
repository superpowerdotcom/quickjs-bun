#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "quickjs.h"

typedef struct QJSBunHostRequest {
  uint32_t host_id;
  uint32_t argc;
  JSValue this_val;
  const JSValue *argv;
  JSValue out;
} QJSBunHostRequest;

typedef void (*QJSBunHostCallback)(QJSBunHostRequest *);
typedef void (*QJSBunPromiseRejectionTracker)(JSContext *, const JSValue *,
                                              const JSValue *, int);
typedef JSModuleDef *(*QJSBunModuleLoader)(JSContext *, const char *,
                                           const JSValue *);
typedef void (*QJSBunHostSlotFinalizer)(JSRuntime *, JSContext *, uint32_t);

#define QJS_OUT(name, params, ...)                                             \
  void name params { *out = (__VA_ARGS__); }
#define QJS_RET(type, name, params, ...)                                       \
  type name params { return (__VA_ARGS__); }
#define QJS_CLASS_OBJECT 1

int qjs_bun_js_module_set_import_meta(JSContext *ctx, const JSValue *v,
                                      int use_realpath, int is_main);

static QJSBunHostSlotFinalizer qjs_bun_host_slot_finalizer_cb = NULL;
static JSClassID qjs_bun_host_slot_class_id = 0;

typedef struct QJSBunHostSlot {
  JSContext *ctx;
  uint32_t host_id;
} QJSBunHostSlot;

static void qjs_bun_host_slot_finalize(JSRuntime *rt, JSValue val) {
  QJSBunHostSlot *slot = JS_GetOpaque(val, qjs_bun_host_slot_class_id);
  if (!slot)
    return;
  if (qjs_bun_host_slot_finalizer_cb)
    qjs_bun_host_slot_finalizer_cb(rt, slot->ctx, slot->host_id);
  js_free_rt(rt, slot);
}

void qjs_bun_set_host_slot_finalizer(QJSBunHostSlotFinalizer cb) {
  qjs_bun_host_slot_finalizer_cb = cb;
}

int qjs_bun_init_host_slot_class(JSRuntime *rt) {
  if (qjs_bun_host_slot_class_id == 0)
    JS_NewClassID(&qjs_bun_host_slot_class_id);
  JSClassDef def = {
      .class_name = "QJSBunHostSlot",
      .finalizer = qjs_bun_host_slot_finalize,
  };
  return JS_NewClass(rt, qjs_bun_host_slot_class_id, &def);
}

int qjs_bun_new_class(JSRuntime *rt, uint32_t class_id, const char *name) {
  JSClassDef def = {.class_name = name};
  return JS_NewClass(rt, class_id, &def);
}

JSModuleDef *qjs_bun_compile_module(JSContext *ctx, const uint8_t *source,
                                    uint64_t len, const char *filename) {
  JSValue value = JS_EvalInternal(
      ctx, ctx->global_obj, (const char *)source, (size_t)len, filename,
      JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY, -1);
  if (JS_IsException(value))
    return NULL;
  if (qjs_bun_js_module_set_import_meta(ctx, &value, 0, 0) < 0) {
    JS_FreeValue(ctx, value);
    return NULL;
  }
  JSModuleDef *module = JS_VALUE_GET_PTR(value);
  JS_FreeValue(ctx, value);
  return module;
}

char *qjs_bun_dump_memory_usage(JSRuntime *rt, uint64_t *len) {
  *len = 0;
  JSMemoryUsage usage;
  JS_ComputeMemoryUsage(rt, &usage);
  FILE *file = tmpfile();
  if (!file)
    return NULL;
  JS_DumpMemoryUsage(file, &usage, rt);
  if (fflush(file) != 0 || fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  long size = ftell(file);
  if (size < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return NULL;
  }
  char *text = js_malloc_rt(rt, (size_t)size + 1);
  if (!text) {
    fclose(file);
    return NULL;
  }
  size_t read_size = fread(text, 1, (size_t)size, file);
  fclose(file);
  if (read_size != (size_t)size) {
    js_free_rt(rt, text);
    return NULL;
  }
  text[size] = '\0';
  *len = (uint64_t)size;
  return text;
}

static JSValue qjs_bun_host_trampoline(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv, int magic,
                                       JSValue *func_data) {
  uintptr_t callback_ptr = (uint32_t)JS_VALUE_GET_INT(func_data[0]);
#if UINTPTR_MAX > UINT32_MAX
  callback_ptr |= (uintptr_t)(uint32_t)JS_VALUE_GET_INT(func_data[1]) << 32;
#endif
  QJSBunHostCallback callback = (QJSBunHostCallback)callback_ptr;
  QJSBunHostRequest request = {.host_id = (uint32_t)magic,
                               .argc = (uint32_t)argc,
                               .this_val = this_val,
                               .argv = argv,
                               .out = JS_UNDEFINED};
  callback(&request);
  return request.out;
}

static JSValue qjs_bun_host_job_trampoline(JSContext *ctx, int argc,
                                           JSValueConst *argv) {
  if (argc < 4)
    return JS_ThrowInternalError(ctx, "host job data is missing");
  uintptr_t callback_ptr = (uint32_t)JS_VALUE_GET_INT(argv[0]);
#if UINTPTR_MAX > UINT32_MAX
  callback_ptr |= (uintptr_t)(uint32_t)JS_VALUE_GET_INT(argv[1]) << 32;
#endif
  QJSBunHostCallback callback = (QJSBunHostCallback)callback_ptr;
  if (!callback)
    return JS_ThrowInternalError(ctx, "host job callback is not registered");
  QJSBunHostRequest request = {.host_id = (uint32_t)JS_VALUE_GET_INT(argv[2]),
                               .argc = (uint32_t)(argc - 4),
                               .this_val = JS_UNDEFINED,
                               .argv = argv + 4,
                               .out = JS_UNDEFINED};
  callback(&request);
  return request.out;
}

static void qjs_bun_promise_rejection_trampoline(JSContext *ctx,
                                                 JSValueConst promise,
                                                 JSValueConst reason,
                                                 JS_BOOL is_handled,
                                                 void *opaque) {
  QJSBunPromiseRejectionTracker callback =
      (QJSBunPromiseRejectionTracker)opaque;
  callback(ctx, &promise, &reason, is_handled);
}

static JSModuleDef *qjs_bun_module_loader_trampoline(JSContext *ctx,
                                                     const char *module_name,
                                                     void *opaque,
                                                     JSValueConst attributes) {
  QJSBunModuleLoader callback = (QJSBunModuleLoader)opaque;
  return callback(ctx, module_name, &attributes);
}

void qjs_bun_set_host_promise_rejection_tracker(
    JSRuntime *rt, QJSBunPromiseRejectionTracker callback) {
  JS_SetHostPromiseRejectionTracker(
      rt, callback ? qjs_bun_promise_rejection_trampoline : NULL, callback);
}

void qjs_bun_set_module_loader_func2(JSRuntime *rt,
                                     QJSBunModuleLoader callback) {
  JS_SetModuleLoaderFunc2(rt, NULL,
                          callback ? qjs_bun_module_loader_trampoline : NULL,
                          NULL, callback);
}

void qjs_bun_eval(JSContext *ctx, JSValue *out, const uint8_t *s, uint64_t len,
                  const char *file, int flags) {
  *out = JS_EvalInternal(ctx, ctx->global_obj, (const char *)s, (size_t)len,
                         file, flags, -1);
}
void qjs_bun_eval_this(JSContext *ctx, JSValue *out, const JSValue *this_val,
                       const uint8_t *s, uint64_t len, const char *file,
                       int flags) {
  *out = JS_EvalInternal(ctx, *this_val, (const char *)s, (size_t)len, file,
                         flags, -1);
}
QJS_OUT(qjs_bun_call,
        (JSContext * ctx, JSValue *out, const JSValue *fn,
         const JSValue *this_val, uint32_t argc, JSValue *argv),
        JS_Call(ctx, *fn, *this_val, (int)argc, argv))
QJS_OUT(qjs_bun_invoke,
        (JSContext * ctx, JSValue *out, const JSValue *this_val, uint32_t atom,
         uint32_t argc, JSValue *argv),
        JS_Invoke(ctx, *this_val, atom, (int)argc, argv))
QJS_OUT(qjs_bun_call_constructor,
        (JSContext * ctx, JSValue *out, const JSValue *fn, uint32_t argc,
         JSValue *argv),
        JS_CallConstructor(ctx, *fn, (int)argc, argv))
QJS_OUT(qjs_bun_call_constructor2,
        (JSContext * ctx, JSValue *out, const JSValue *fn,
         const JSValue *target, uint32_t argc, JSValue *argv),
        JS_CallConstructor2(ctx, *fn, *target, (int)argc, argv))
QJS_OUT(qjs_bun_string_code_point_range,
        (JSContext * ctx, JSValue *out, const JSValue *this_val, uint32_t argc,
         JSValue *argv),
        js_string_codePointRange(ctx, *this_val, (int)argc, argv))
QJS_OUT(qjs_bun_get_exception, (JSContext * ctx, JSValue *out),
        JS_GetException(ctx))
QJS_OUT(qjs_bun_get_global, (JSContext * ctx, JSValue *out),
        JS_GetGlobalObject(ctx))
QJS_OUT(qjs_bun_new_string, (JSContext * ctx, const char *s, JSValue *out),
        JS_NewString(ctx, s))
QJS_OUT(qjs_bun_new_string_len,
        (JSContext * ctx, const uint8_t *s, uint64_t len, JSValue *out),
        JS_NewStringLen(ctx, (const char *)s, (size_t)len))
QJS_OUT(qjs_bun_new_object, (JSContext * ctx, JSValue *out), JS_NewObject(ctx))
QJS_OUT(qjs_bun_new_array, (JSContext * ctx, JSValue *out), JS_NewArray(ctx))
QJS_OUT(qjs_bun_new_error, (JSContext * ctx, JSValue *out), JS_NewError(ctx))
QJS_OUT(qjs_bun_new_promise,
        (JSContext * ctx, JSValue *resolving, JSValue *out),
        JS_NewPromiseCapability(ctx, resolving))
QJS_OUT(qjs_bun_throw, (JSContext * ctx, const JSValue *v, JSValue *out),
        JS_Throw(ctx, *v))
void qjs_bun_get_data_property(JSContext *ctx, const JSValue *obj,
                               uint32_t atom, JSValue *out) {
  *out = JS_UNDEFINED;
  JSValue current = JS_DupValue(ctx, *obj);
  for (;;) {
    JSPropertyDescriptor desc;
    int ok = JS_GetOwnProperty(ctx, &desc, current, atom);
    if (ok < 0) {
      *out = JS_EXCEPTION;
      break;
    }
    if (ok) {
      if (!(desc.flags & JS_PROP_GETSET))
        *out = JS_DupValue(ctx, desc.value);
      JS_FreeValue(ctx, desc.value);
      JS_FreeValue(ctx, desc.getter);
      JS_FreeValue(ctx, desc.setter);
      break;
    }
    JSValue next = JS_GetPrototype(ctx, current);
    JS_FreeValue(ctx, current);
    if (JS_IsException(next)) {
      *out = next;
      current = JS_UNDEFINED;
      break;
    }
    current = next;
    if (JS_GetClassID(current) != QJS_CLASS_OBJECT)
      break;
  }
  JS_FreeValue(ctx, current);
}
QJS_OUT(qjs_bun_get_property_str,
        (JSContext * ctx, const JSValue *obj, const char *s, JSValue *out),
        JS_GetPropertyStr(ctx, *obj, s))
QJS_OUT(qjs_bun_get_property_u32,
        (JSContext * ctx, const JSValue *obj, uint32_t i, JSValue *out),
        JS_GetPropertyUint32(ctx, *obj, i))
QJS_OUT(qjs_bun_promise_result,
        (JSContext * ctx, const JSValue *v, JSValue *out),
        JS_PromiseResult(ctx, *v))
QJS_OUT(qjs_bun_read_object,
        (JSContext * ctx, const uint8_t *s, uint64_t len, int flags,
         JSValue *out),
        JS_ReadObject(ctx, s, (size_t)len, flags))
QJS_OUT(qjs_bun_throw_syntax_error,
        (JSContext * ctx, const char *s, JSValue *out),
        JS_ThrowSyntaxError(ctx, "%s", s))
QJS_OUT(qjs_bun_throw_type_error,
        (JSContext * ctx, const char *s, JSValue *out),
        JS_ThrowTypeError(ctx, "%s", s))
QJS_OUT(qjs_bun_throw_reference_error,
        (JSContext * ctx, const char *s, JSValue *out),
        JS_ThrowReferenceError(ctx, "%s", s))
QJS_OUT(qjs_bun_throw_range_error,
        (JSContext * ctx, const char *s, JSValue *out),
        JS_ThrowRangeError(ctx, "%s", s))
QJS_OUT(qjs_bun_throw_internal_error,
        (JSContext * ctx, const char *s, JSValue *out),
        JS_ThrowInternalError(ctx, "%s", s))
QJS_OUT(qjs_bun_throw_out_of_memory, (JSContext * ctx, JSValue *out),
        JS_ThrowOutOfMemory(ctx))
QJS_OUT(qjs_bun_new_bool, (JSContext * ctx, int v, JSValue *out),
        JS_NewBool(ctx, v))
QJS_OUT(qjs_bun_new_catch_offset, (JSContext * ctx, int32_t v, JSValue *out),
        JS_NewCatchOffset(ctx, v))
QJS_OUT(qjs_bun_new_int32, (JSContext * ctx, int32_t v, JSValue *out),
        JS_NewInt32(ctx, v))
QJS_OUT(qjs_bun_new_int64, (JSContext * ctx, int64_t v, JSValue *out),
        JS_NewInt64(ctx, v))
QJS_OUT(qjs_bun_new_uint32, (JSContext * ctx, uint32_t v, JSValue *out),
        JS_NewUint32(ctx, v))
QJS_OUT(qjs_bun_new_float64, (JSContext * ctx, double v, JSValue *out),
        JS_NewFloat64(ctx, v))
QJS_OUT(qjs_bun_new_bigint64, (JSContext * ctx, int64_t v, JSValue *out),
        JS_NewBigInt64(ctx, v))
QJS_OUT(qjs_bun_new_biguint64, (JSContext * ctx, uint64_t v, JSValue *out),
        JS_NewBigUint64(ctx, v))
QJS_OUT(qjs_bun_new_atom_string, (JSContext * ctx, const char *s, JSValue *out),
        JS_NewAtomString(ctx, s))
QJS_OUT(qjs_bun_atom_to_value, (JSContext * ctx, uint32_t atom, JSValue *out),
        JS_AtomToValue(ctx, atom))
QJS_OUT(qjs_bun_atom_to_string, (JSContext * ctx, uint32_t atom, JSValue *out),
        JS_AtomToString(ctx, atom))
QJS_OUT(qjs_bun_to_string, (JSContext * ctx, const JSValue *v, JSValue *out),
        JS_ToString(ctx, *v))
QJS_OUT(qjs_bun_to_property_key,
        (JSContext * ctx, const JSValue *v, JSValue *out),
        JS_ToPropertyKey(ctx, *v))
QJS_OUT(qjs_bun_get_class_proto,
        (JSContext * ctx, uint32_t class_id, JSValue *out),
        JS_GetClassProto(ctx, class_id))
QJS_OUT(qjs_bun_new_object_proto,
        (JSContext * ctx, const JSValue *proto, JSValue *out),
        JS_NewObjectProto(ctx, *proto))
QJS_OUT(qjs_bun_new_object_class, (JSContext * ctx, int class_id, JSValue *out),
        JS_NewObjectClass(ctx, class_id))
QJS_OUT(qjs_bun_new_object_proto_class,
        (JSContext * ctx, const JSValue *proto, int class_id, JSValue *out),
        JS_NewObjectProtoClass(ctx, *proto, class_id))
void qjs_bun_new_date(JSContext *ctx, const double *epoch_ms, JSValue *out) {
  *out = JS_NewDate(ctx, *epoch_ms);
}
QJS_OUT(qjs_bun_get_property,
        (JSContext * ctx, const JSValue *obj, uint32_t atom, JSValue *out),
        JS_GetProperty(ctx, *obj, atom))
QJS_OUT(qjs_bun_get_property_internal,
        (JSContext * ctx, const JSValue *obj, uint32_t atom,
         const JSValue *receiver, int throw_ref_error, JSValue *out),
        JS_GetPropertyInternal(ctx, *obj, atom, *receiver, throw_ref_error))
QJS_OUT(qjs_bun_get_prototype,
        (JSContext * ctx, const JSValue *obj, JSValue *out),
        JS_GetPrototype(ctx, *obj))
QJS_OUT(qjs_bun_parse_json,
        (JSContext * ctx, JSValue *out, const uint8_t *s, uint64_t len,
         const char *file),
        JS_ParseJSON(ctx, (const char *)s, (size_t)len, file))
QJS_OUT(qjs_bun_parse_json2,
        (JSContext * ctx, JSValue *out, const uint8_t *s, uint64_t len,
         const char *file, int flags),
        JS_ParseJSON2(ctx, (const char *)s, (size_t)len, file, flags))
QJS_OUT(qjs_bun_json_stringify,
        (JSContext * ctx, JSValue *out, const JSValue *obj,
         const JSValue *replacer, const JSValue *space),
        JS_JSONStringify(ctx, *obj, *replacer, *space))
QJS_OUT(qjs_bun_new_array_buffer,
        (JSContext * ctx, JSValue *out, uint8_t *buf, uint64_t len,
         JSFreeArrayBufferDataFunc *free_func, void *opaque, int is_shared),
        JS_NewArrayBuffer(ctx, buf, (size_t)len, free_func, opaque, is_shared))
QJS_OUT(qjs_bun_new_array_buffer_copy,
        (JSContext * ctx, JSValue *out, const uint8_t *buf, uint64_t len),
        JS_NewArrayBufferCopy(ctx, buf, (size_t)len))
QJS_OUT(qjs_bun_new_typed_array,
        (JSContext * ctx, JSValue *out, int argc, JSValue *argv, int type),
        JS_NewTypedArray(ctx, argc, argv, type))
QJS_OUT(qjs_bun_get_typed_array_buffer,
        (JSContext * ctx, const JSValue *obj, void *byte_offset,
         void *byte_length, void *bytes_per_element, JSValue *out),
        JS_GetTypedArrayBuffer(ctx, *obj, byte_offset, byte_length,
                               bytes_per_element))
QJS_OUT(qjs_bun_get_import_meta,
        (JSContext * ctx, JSModuleDef *module, JSValue *out),
        JS_GetImportMeta(ctx, module))
QJS_OUT(qjs_bun_get_module_namespace,
        (JSContext * ctx, JSModuleDef *module, JSValue *out),
        JS_GetModuleNamespace(ctx, module))
QJS_OUT(qjs_bun_load_module,
        (JSContext * ctx, JSValue *out, const char *basename,
         const char *filename),
        JS_LoadModule(ctx, basename, filename))
QJS_OUT(qjs_bun_eval_function,
        (JSContext * ctx, JSValue *out, const JSValue *v),
        JS_EvalFunctionInternal(ctx, *v, ctx->global_obj, NULL, NULL))
QJS_OUT(qjs_bun_new_c_function,
        (JSContext * ctx, JSCFunction *fn, const char *name, int length,
         JSValue *out),
        JS_NewCFunction(ctx, fn, name, length))
QJS_OUT(qjs_bun_new_c_function_magic,
        (JSContext * ctx, JSCFunctionMagic *fn, const char *name, int length,
         int cproto, int magic, JSValue *out),
        JS_NewCFunctionMagic(ctx, fn, name, length, cproto, magic))
QJS_OUT(qjs_bun_new_c_function2,
        (JSContext * ctx, JSCFunction *fn, const char *name, int length,
         int cproto, int magic, JSValue *out),
        JS_NewCFunction2(ctx, fn, name, length, cproto, magic))
QJS_OUT(qjs_bun_new_c_function_data,
        (JSContext * ctx, JSValue *out, JSCFunctionData *fn, int length,
         int magic, int data_len, JSValue *data),
        JS_NewCFunctionData(ctx, fn, length, magic, data_len, data))
QJS_OUT(qjs_bun_get_module_private_value,
        (JSContext * ctx, JSModuleDef *module, JSValue *out),
        JS_GetModulePrivateValue(ctx, module))
QJS_RET(int, qjs_bun_get_own_property_names,
        (JSContext * ctx, void *tab, void *len, const JSValue *v, int flags),
        JS_GetOwnPropertyNames(ctx, tab, len, *v, flags))
QJS_RET(int, qjs_bun_get_own_property,
        (JSContext * ctx, void *desc, const JSValue *obj, uint32_t atom),
        JS_GetOwnProperty(ctx, desc, *obj, atom))
QJS_RET(int, qjs_bun_is_number, (const JSValue *v), JS_IsNumber(*v))
QJS_RET(int, qjs_bun_is_bigint, (JSContext * ctx, const JSValue *v),
        JS_IsBigInt(ctx, *v))
QJS_RET(int, qjs_bun_is_bool, (const JSValue *v), JS_IsBool(*v))
QJS_RET(int, qjs_bun_is_null, (const JSValue *v), JS_IsNull(*v))
QJS_RET(int, qjs_bun_is_undefined, (const JSValue *v), JS_IsUndefined(*v))
QJS_RET(int, qjs_bun_is_exception, (const JSValue *v), JS_IsException(*v))
QJS_RET(int, qjs_bun_is_uninitialized, (const JSValue *v),
        JS_IsUninitialized(*v))
QJS_RET(int, qjs_bun_is_string, (const JSValue *v), JS_IsString(*v))
QJS_RET(int, qjs_bun_is_symbol, (const JSValue *v), JS_IsSymbol(*v))
QJS_RET(int, qjs_bun_is_object, (const JSValue *v), JS_IsObject(*v))
QJS_RET(int, qjs_bun_is_live_object, (JSRuntime * rt, const JSValue *obj),
        JS_IsLiveObject(rt, *obj))
QJS_RET(int, qjs_bun_is_array, (JSContext * ctx, const JSValue *v),
        JS_IsArray(ctx, *v))
QJS_RET(int, qjs_bun_is_error, (JSContext * ctx, const JSValue *v),
        JS_IsError(ctx, *v))
QJS_RET(int, qjs_bun_is_function, (JSContext * ctx, const JSValue *v),
        JS_IsFunction(ctx, *v))
QJS_RET(int, qjs_bun_is_constructor, (JSContext * ctx, const JSValue *v),
        JS_IsConstructor(ctx, *v))
QJS_RET(int, qjs_bun_is_instance_of,
        (JSContext * ctx, const JSValue *v, const JSValue *obj),
        JS_IsInstanceOf(ctx, *v, *obj))
QJS_RET(int, qjs_bun_promise_state, (JSContext * ctx, const JSValue *v),
        JS_PromiseState(ctx, *v))
QJS_RET(int, qjs_bun_set_property_str,
        (JSContext * ctx, const JSValue *obj, const char *s, const JSValue *v),
        JS_SetPropertyStr(ctx, *obj, s, *v))
QJS_RET(int, qjs_bun_set_property_u32,
        (JSContext * ctx, const JSValue *obj, uint32_t i, const JSValue *v),
        JS_SetPropertyUint32(ctx, *obj, i, *v))
QJS_RET(int, qjs_bun_set_property,
        (JSContext * ctx, const JSValue *obj, uint32_t atom, const JSValue *v),
        JS_SetProperty(ctx, *obj, atom, *v))
QJS_RET(int, qjs_bun_set_property_internal,
        (JSContext * ctx, const JSValue *obj, uint32_t atom, const JSValue *v,
         const JSValue *receiver, int flags),
        JS_SetPropertyInternal(ctx, *obj, atom, *v, *receiver, flags))
QJS_RET(int, qjs_bun_set_property_i64,
        (JSContext * ctx, const JSValue *obj, int64_t i, const JSValue *v),
        JS_SetPropertyInt64(ctx, *obj, i, *v))
QJS_RET(int, qjs_bun_has_property,
        (JSContext * ctx, const JSValue *obj, uint32_t atom),
        JS_HasProperty(ctx, *obj, atom))
QJS_RET(int, qjs_bun_delete_property,
        (JSContext * ctx, const JSValue *obj, uint32_t atom, int flags),
        JS_DeleteProperty(ctx, *obj, atom, flags))
QJS_RET(int, qjs_bun_is_extensible, (JSContext * ctx, const JSValue *obj),
        JS_IsExtensible(ctx, *obj))
QJS_RET(int, qjs_bun_prevent_extensions, (JSContext * ctx, const JSValue *obj),
        JS_PreventExtensions(ctx, *obj))
QJS_RET(int, qjs_bun_set_prototype,
        (JSContext * ctx, const JSValue *obj, const JSValue *proto),
        JS_SetPrototype(ctx, *obj, *proto))
QJS_RET(int, qjs_bun_set_constructor_bit,
        (JSContext * ctx, const JSValue *fn, int v),
        JS_SetConstructorBit(ctx, *fn, v))
QJS_RET(int, qjs_bun_set_constructor,
        (JSContext * ctx, const JSValue *fn, const JSValue *proto),
        JS_SetConstructor(ctx, *fn, *proto))
QJS_RET(int, qjs_bun_strict_eq,
        (JSContext * ctx, const JSValue *a, const JSValue *b),
        JS_StrictEq(ctx, *a, *b))
QJS_RET(int, qjs_bun_same_value,
        (JSContext * ctx, const JSValue *a, const JSValue *b),
        JS_SameValue(ctx, *a, *b))
QJS_RET(int, qjs_bun_same_value_zero,
        (JSContext * ctx, const JSValue *a, const JSValue *b),
        JS_SameValueZero(ctx, *a, *b))
QJS_RET(int, qjs_bun_to_int32,
        (JSContext * ctx, int32_t *out, const JSValue *v),
        JS_ToInt32(ctx, out, *v))
QJS_RET(int, qjs_bun_to_uint32,
        (JSContext * ctx, uint32_t *out, const JSValue *v),
        JS_ToUint32(ctx, out, *v))
QJS_RET(int, qjs_bun_to_int64,
        (JSContext * ctx, int64_t *out, const JSValue *v),
        JS_ToInt64(ctx, out, *v))
QJS_RET(int, qjs_bun_to_index,
        (JSContext * ctx, uint64_t *out, const JSValue *v),
        JS_ToIndex(ctx, out, *v))
QJS_RET(int, qjs_bun_to_bigint64,
        (JSContext * ctx, int64_t *out, const JSValue *v),
        JS_ToBigInt64(ctx, out, *v))
QJS_RET(int, qjs_bun_to_int64_ext,
        (JSContext * ctx, int64_t *out, const JSValue *v),
        JS_ToInt64Ext(ctx, out, *v))
QJS_RET(int, qjs_bun_define_property,
        (JSContext * ctx, const JSValue *obj, uint32_t atom, const JSValue *v,
         const JSValue *getter, const JSValue *setter, int flags),
        JS_DefineProperty(ctx, *obj, atom, *v, *getter, *setter, flags))
QJS_RET(int, qjs_bun_define_property_value,
        (JSContext * ctx, const JSValue *obj, uint32_t atom, const JSValue *v,
         int flags),
        JS_DefinePropertyValue(ctx, *obj, atom, *v, flags))
QJS_RET(int, qjs_bun_define_property_value_u32,
        (JSContext * ctx, const JSValue *obj, uint32_t i, const JSValue *v,
         int flags),
        JS_DefinePropertyValueUint32(ctx, *obj, i, *v, flags))
QJS_RET(int, qjs_bun_define_property_value_str,
        (JSContext * ctx, const JSValue *obj, const char *s, const JSValue *v,
         int flags),
        JS_DefinePropertyValueStr(ctx, *obj, s, *v, flags))
QJS_RET(int, qjs_bun_define_property_get_set,
        (JSContext * ctx, const JSValue *obj, uint32_t atom,
         const JSValue *getter, const JSValue *setter, int flags),
        JS_DefinePropertyGetSet(ctx, *obj, atom, *getter, *setter, flags))
QJS_RET(int, qjs_bun_resolve_module, (JSContext * ctx, const JSValue *v),
        JS_ResolveModule(ctx, *v))
QJS_RET(int, qjs_bun_set_property_function_list,
        (JSContext * ctx, const JSValue *obj, const void *tab, int len),
        JS_SetPropertyFunctionList(ctx, *obj, tab, len))
QJS_RET(int, qjs_bun_set_module_export,
        (JSContext * ctx, JSModuleDef *module, const char *name,
         const JSValue *v),
        JS_SetModuleExport(ctx, module, name, *v))
QJS_RET(int, qjs_bun_set_module_private_value,
        (JSContext * ctx, JSModuleDef *module, const JSValue *v),
        JS_SetModulePrivateValue(ctx, module, *v))
QJS_RET(int, qjs_bun_to_bool, (JSContext * ctx, const JSValue *v),
        JS_ToBool(ctx, *v))
QJS_RET(int, qjs_bun_to_float64,
        (JSContext * ctx, double *out, const JSValue *v),
        JS_ToFloat64(ctx, out, *v))
QJS_RET(uint32_t, qjs_bun_get_class_id, (const JSValue *v), JS_GetClassID(*v))
QJS_RET(uint32_t, qjs_bun_value_to_atom, (JSContext * ctx, const JSValue *v),
        JS_ValueToAtom(ctx, *v))
QJS_RET(int, qjs_bun_value_get_norm_tag, (const JSValue *v),
        JS_VALUE_GET_NORM_TAG(*v))
QJS_RET(int, qjs_bun_value_is_nan, (const JSValue *v), JS_VALUE_IS_NAN(*v))
QJS_RET(double, qjs_bun_value_get_float64, (const JSValue *v),
        JS_VALUE_GET_FLOAT64(*v))
QJS_RET(const char *, qjs_bun_to_cstring, (JSContext * ctx, const JSValue *v),
        JS_ToCString(ctx, *v))
QJS_RET(const char *, qjs_bun_to_cstring_len,
        (JSContext * ctx, void *len, const JSValue *v),
        JS_ToCStringLen(ctx, len, *v))
QJS_RET(const char *, qjs_bun_to_cstring_len2,
        (JSContext * ctx, void *len, const JSValue *v, int cesu8),
        JS_ToCStringLen2(ctx, len, *v, cesu8))
QJS_RET(void *, qjs_bun_get_opaque, (const JSValue *obj, uint32_t class_id),
        JS_GetOpaque(*obj, class_id))
QJS_RET(void *, qjs_bun_get_opaque2,
        (JSContext * ctx, const JSValue *obj, uint32_t class_id),
        JS_GetOpaque2(ctx, *obj, class_id))
QJS_RET(void *, qjs_bun_get_any_opaque, (const JSValue *obj, void *class_id),
        JS_GetAnyOpaque(*obj, class_id))
QJS_RET(uint8_t *, qjs_bun_get_array_buffer,
        (JSContext * ctx, void *size, const JSValue *obj),
        JS_GetArrayBuffer(ctx, size, *obj))
QJS_RET(uint8_t *, qjs_bun_write_object,
        (JSContext * ctx, void *size, const JSValue *v, int flags),
        JS_WriteObject(ctx, size, *v, flags))
QJS_RET(uint8_t *, qjs_bun_write_object2,
        (JSContext * ctx, void *size, const JSValue *v, int flags,
         void *sab_tab, void *sab_tab_len),
        JS_WriteObject2(ctx, size, *v, flags, sab_tab, sab_tab_len))
int qjs_bun_js_module_set_import_meta(JSContext *ctx, const JSValue *v,
                                      int use_realpath, int is_main) {
  (void)use_realpath;
  if (JS_VALUE_GET_TAG(*v) != JS_TAG_MODULE) {
    JS_ThrowTypeError(ctx, "value is not a module");
    return -1;
  }

  JSModuleDef *module = JS_VALUE_GET_PTR(*v);
  JSAtom module_name_atom = JS_GetModuleName(ctx, module);
  const char *module_name = JS_AtomToCString(ctx, module_name_atom);
  JS_FreeAtom(ctx, module_name_atom);
  if (!module_name)
    return -1;

  char *owned_url = NULL;
  const char *url = module_name;
  if (!strchr(module_name, ':')) {
    size_t prefix_len = strlen("file://");
    size_t module_name_len = strlen(module_name);
    owned_url = js_malloc(ctx, prefix_len + module_name_len + 1);
    if (!owned_url) {
      JS_FreeCString(ctx, module_name);
      return -1;
    }
    memcpy(owned_url, "file://", prefix_len);
    memcpy(owned_url + prefix_len, module_name, module_name_len + 1);
    url = owned_url;
  }

  int ret = 0;
  JSValue meta = JS_GetImportMeta(ctx, module);
  if (JS_IsException(meta)) {
    ret = -1;
  } else {
    ret |= JS_DefinePropertyValueStr(ctx, meta, "url", JS_NewString(ctx, url),
                                     JS_PROP_C_W_E);
    ret |= JS_DefinePropertyValueStr(ctx, meta, "main",
                                     JS_NewBool(ctx, is_main), JS_PROP_C_W_E);
    JS_FreeValue(ctx, meta);
  }
  if (owned_url)
    js_free(ctx, owned_url);
  JS_FreeCString(ctx, module_name);
  return ret < 0 ? -1 : 0;
}

static JSValue qjs_bun_make_host_slot(JSContext *ctx, int32_t host_id) {
  JSValue slot_val = JS_NewObjectClass(ctx, qjs_bun_host_slot_class_id);
  if (JS_IsException(slot_val))
    return slot_val;
  QJSBunHostSlot *slot = js_malloc(ctx, sizeof(*slot));
  if (!slot) {
    JS_FreeValue(ctx, slot_val);
    return JS_EXCEPTION;
  }
  slot->ctx = ctx;
  slot->host_id = (uint32_t)host_id;
  JS_SetOpaque(slot_val, slot);
  return slot_val;
}

void qjs_bun_new_host_function(JSContext *ctx, QJSBunHostCallback callback,
                               int32_t host_id, JSValue *out) {
  if (!callback) {
    *out = JS_ThrowInternalError(ctx, "host callback is not registered");
    return;
  }
  JSValue slot_val = qjs_bun_make_host_slot(ctx, host_id);
  if (JS_IsException(slot_val)) {
    *out = slot_val;
    return;
  }
  uintptr_t callback_ptr = (uintptr_t)callback;
  JSValue data[3] = {
      JS_NewInt32(ctx, (int32_t)(uint32_t)callback_ptr),
      JS_NewInt32(ctx, 0),
      slot_val,
  };
#if UINTPTR_MAX > UINT32_MAX
  data[1] = JS_NewInt32(ctx, (int32_t)(uint32_t)(callback_ptr >> 32));
#endif
  *out = JS_NewCFunctionData(ctx, qjs_bun_host_trampoline, 0, host_id, 3, data);
  JS_FreeValue(ctx, slot_val);
}
int qjs_bun_enqueue_host_job(JSContext *ctx, QJSBunHostCallback callback,
                             int32_t host_id, uint32_t argc, JSValue *argv) {
  if (!callback)
    return JS_ThrowInternalError(ctx, "host job callback is not registered"),
           -1;
  JSValue slot_val = qjs_bun_make_host_slot(ctx, host_id);
  if (JS_IsException(slot_val))
    return -1;
  uintptr_t callback_ptr = (uintptr_t)callback;
  uint32_t data_count = argc + 4;
  JSValue *data = js_malloc(ctx, sizeof(JSValue) * data_count);
  if (!data) {
    JS_FreeValue(ctx, slot_val);
    return -1;
  }
  data[0] = JS_NewInt32(ctx, (int32_t)(uint32_t)callback_ptr);
  data[1] = JS_NewInt32(ctx, 0);
#if UINTPTR_MAX > UINT32_MAX
  data[1] = JS_NewInt32(ctx, (int32_t)(uint32_t)(callback_ptr >> 32));
#endif
  data[2] = JS_NewInt32(ctx, host_id);
  data[3] = slot_val;
  for (uint32_t i = 0; i < argc; i++)
    data[i + 4] = argv[i];
  int ret =
      JS_EnqueueJob(ctx, qjs_bun_host_job_trampoline, (int)data_count, data);
  JS_FreeValue(ctx, slot_val);
  js_free(ctx, data);
  return ret;
}
void qjs_bun_mark_value(JSRuntime *rt, const JSValue *v,
                        JS_MarkFunc *mark_func) {
  JS_MarkValue(rt, *v, mark_func);
}
void qjs_bun_set_class_proto(JSContext *ctx, uint32_t class_id,
                             const JSValue *proto) {
  JS_SetClassProto(ctx, class_id, *proto);
}
void qjs_bun_free_value(JSContext *ctx, const JSValue *v) {
  JS_FreeValue(ctx, *v);
}
void qjs_bun_free_value_rt(JSRuntime *rt, const JSValue *v) {
  JS_FreeValueRT(rt, *v);
}
void qjs_bun_detach_array_buffer(JSContext *ctx, const JSValue *obj) {
  JS_DetachArrayBuffer(ctx, *obj);
}
void qjs_bun_set_is_html_dda(JSContext *ctx, const JSValue *obj) {
  JS_SetIsHTMLDDA(ctx, *obj);
}
void qjs_bun_set_opaque(const JSValue *obj, void *opaque) {
  JS_SetOpaque(*obj, opaque);
}
void qjs_bun_print_value_rt(JSRuntime *rt, JSPrintValueWrite *write,
                            void *opaque, const JSValue *v,
                            const void *options) {
  JS_PrintValueRT(rt, write, opaque, *v, options);
}
void qjs_bun_print_value(JSContext *ctx, JSPrintValueWrite *write, void *opaque,
                         const JSValue *v, const void *options) {
  JS_PrintValue(ctx, write, opaque, *v, options);
}
void qjs_bun_print_value_options(JSContext *ctx, JSPrintValueWrite *write,
                                 void *opaque, const JSValue *v,
                                 int show_hidden, int raw_dump,
                                 uint32_t max_depth, uint32_t max_string_length,
                                 uint32_t max_item_count) {
  JSPrintValueOptions options;
  JS_PrintValueSetDefaultOptions(&options);
  if (show_hidden >= 0)
    options.show_hidden = show_hidden != 0;
  if (raw_dump >= 0)
    options.raw_dump = raw_dump != 0;
  if (max_depth != UINT32_MAX)
    options.max_depth = max_depth;
  if (max_string_length != UINT32_MAX)
    options.max_string_length = max_string_length;
  if (max_item_count != UINT32_MAX)
    options.max_item_count = max_item_count;
  JS_PrintValue(ctx, write, opaque, *v, &options);
}
QJS_OUT(qjs_bun_dup_value, (JSContext * ctx, const JSValue *v, JSValue *out),
        JS_DupValue(ctx, *v))
QJS_OUT(qjs_bun_dup_value_rt, (JSRuntime * rt, const JSValue *v, JSValue *out),
        JS_DupValueRT(rt, *v))
