#undef malloc
#undef free
#undef realloc

#if defined(_WIN32)
#include <windows.h>
static double qjs_bun_now_ms(void) {
  LARGE_INTEGER frequency, counter;
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&counter);
  return (double)counter.QuadPart * 1000.0 / (double)frequency.QuadPart;
}
#else
static double qjs_bun_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
}
#endif

typedef struct QJSBunHostRequest {
  uint32_t kind;
  uint32_t host_id;
  JSContext *ctx;
  uint32_t argc;
  uint32_t flags;
  JSValue this_val;
  const JSValue *argv;
  JSValue out;
} QJSBunHostRequest;

typedef void (*QJSBunHostCallback)(QJSBunHostRequest *);
typedef void (*QJSBunClassFinalizer)(void *opaque);
typedef JSModuleDef *(*QJSBunModuleLoader)(JSContext *, const char *, const JSValue *);
typedef char *(*QJSBunModuleNormalizer)(JSContext *, const char *, const char *);
typedef void (*QJSBunPromiseRejectionTracker)(JSContext *, const JSValue *, const JSValue *, int);

typedef struct QJSBunHostSlot {
  QJSBunHostCallback callback;
  uint32_t host_id;
} QJSBunHostSlot;

typedef struct QJSBunContext {
  JSContext *ctx;
  double timeout_ms;
  struct QJSBunContext *next;
} QJSBunContext;

typedef struct QJSBunRuntime {
  double deadline_ms;
  QJSBunContext *contexts;
  QJSBunClassFinalizer *finalizers;
  uint32_t finalizer_count;
  QJSBunModuleLoader module_loader;
  QJSBunModuleNormalizer module_normalizer;
} QJSBunRuntime;

typedef struct QJSBunScope {
  QJSBunRuntime *state;
  double saved_ms;
  double own_ms;
} QJSBunScope;

static JSClassID qjs_bun_host_class_id;

static int qjs_bun_interrupt(JSRuntime *rt, void *opaque) {
  if (qjs_bun_now_ms() < ((QJSBunRuntime *)opaque)->deadline_ms)
    return 0;
  struct list_head *el;
  list_for_each(el, &rt->context_list)
    list_entry(el, JSContext, link)->interrupt_counter = 2;
  return 1;
}

static QJSBunRuntime *qjs_bun_state(JSRuntime *rt) {
  return rt->interrupt_handler == qjs_bun_interrupt ? rt->interrupt_opaque : NULL;
}

static double qjs_bun_timeout(JSContext *ctx) {
  QJSBunRuntime *state = qjs_bun_state(ctx->rt);
  if (state)
    for (QJSBunContext **link = &state->contexts; *link; link = &(*link)->next)
      if ((*link)->ctx == ctx) {
        QJSBunContext *entry = *link;
        *link = entry->next;
        entry->next = state->contexts;
        state->contexts = entry;
        return entry->timeout_ms;
      }
  return INFINITY;
}

static QJSBunScope qjs_bun_enter(JSRuntime *rt, double timeout_ms) {
  QJSBunScope scope = {qjs_bun_state(rt), 0, 0};
  if (scope.state) {
    scope.saved_ms = scope.state->deadline_ms;
    scope.own_ms = qjs_bun_now_ms() + timeout_ms;
    if (scope.own_ms < scope.saved_ms)
      scope.state->deadline_ms = scope.own_ms;
  }
  return scope;
}

void qjs_bun_timeout_error(JSContext *ctx, JSValue *out);

static void qjs_bun_throw_timeout(JSContext *ctx) {
  JSValue error;
  qjs_bun_timeout_error(ctx, &error);
  if (JS_IsException(error))
    return;
  JS_FreeValue(ctx, JS_GetException(ctx));
  JS_Throw(ctx, error);
}

void qjs_bun_timeout_error(JSContext *ctx, JSValue *out) {
  JSValue error = JS_NewError(ctx);
  if (!JS_IsException(error)) {
    JS_DefinePropertyValue(ctx, error, JS_ATOM_name, JS_NewString(ctx, "TimeoutError"), JS_PROP_C_W_E);
    JS_DefinePropertyValue(ctx, error, JS_ATOM_message, JS_NewString(ctx, "QuickJS execution timed out"), JS_PROP_C_W_E);
  }
  *out = error;
}

void qjs_bun_enter_scope(JSRuntime *rt, double timeout_ms, double *scope) {
  QJSBunScope entered = qjs_bun_enter(rt, timeout_ms);
  scope[0] = entered.saved_ms;
  scope[1] = entered.own_ms;
}

int qjs_bun_leave_scope(JSRuntime *rt, const double *scope) {
  QJSBunRuntime *state = qjs_bun_state(rt);
  if (!state)
    return 0;
  state->deadline_ms = scope[0];
  return qjs_bun_now_ms() >= scope[1];
}

static int qjs_bun_leave(JSContext *ctx, QJSBunScope scope, int failed) {
  if (!scope.state)
    return 0;
  scope.state->deadline_ms = scope.saved_ms;
  if (!failed || qjs_bun_now_ms() < scope.own_ms)
    return 0;
  qjs_bun_throw_timeout(ctx);
  return 1;
}

#define QJS_OUT(name, params, ...) \
  void name params { *out = (__VA_ARGS__); }
#define QJS_RET(type, name, params, ...) \
  type name params { return (__VA_ARGS__); }
#define QJS_GUEST_OUT(name, params, ...) \
  void name params { \
    QJSBunScope scope = qjs_bun_enter(ctx->rt, qjs_bun_timeout(ctx)); \
    *out = (__VA_ARGS__); \
    qjs_bun_leave(ctx, scope, JS_IsException(*out)); \
  }
#define QJS_GUEST_RET(name, params, ...) \
  int name params { \
    QJSBunScope scope = qjs_bun_enter(ctx->rt, qjs_bun_timeout(ctx)); \
    int ret = (__VA_ARGS__); \
    qjs_bun_leave(ctx, scope, ret < 0); \
    return ret; \
  }

static void qjs_bun_hide_atomics(JSContext *ctx) {
#ifdef CONFIG_ATOMICS
  JSValue global = JS_GetGlobalObject(ctx);
  JSAtom atom = JS_NewAtom(ctx, "Atomics");
  JS_DeleteProperty(ctx, global, atom, 0);
  JS_FreeAtom(ctx, atom);
  JS_FreeValue(ctx, global);
#else
  (void)ctx;
#endif
}

static JSValue qjs_bun_host_call(JSContext *ctx, JSValueConst func_obj, JSValueConst this_val, int argc, JSValueConst *argv, int flags) {
  QJSBunHostSlot *slot = JS_GetOpaque(func_obj, qjs_bun_host_class_id);
  if (!slot)
    return JS_ThrowInternalError(ctx, "host function is not initialized");
  QJSBunHostRequest request = {0, slot->host_id, ctx, (uint32_t)argc, (uint32_t)flags, this_val, argv, JS_UNDEFINED};
  slot->callback(&request);
  return request.out;
}

static void qjs_bun_host_finalizer(JSRuntime *rt, JSValue val) {
  QJSBunHostSlot *slot = JS_GetOpaque(val, qjs_bun_host_class_id);
  if (!slot)
    return;
  QJSBunHostRequest request = {1, slot->host_id, NULL, 0, 0, JS_UNDEFINED, NULL, JS_UNDEFINED};
  slot->callback(&request);
  js_free_rt(rt, slot);
}

static void qjs_bun_array_buffer_free(JSRuntime *rt, void *opaque, void *ptr) {
  if (!ptr)
    return;
  QJSBunHostSlot *slot = opaque;
  QJSBunHostRequest request = {1, slot->host_id, NULL, 0, 0, JS_UNDEFINED, NULL, JS_UNDEFINED};
  slot->callback(&request);
  js_free_rt(rt, slot);
}

static void qjs_bun_class_finalize(JSRuntime *rt, JSValue val) {
  QJSBunRuntime *state = qjs_bun_state(rt);
  JSClassID class_id = JS_GetClassID(val);
  if (state && class_id < state->finalizer_count && state->finalizers[class_id])
    state->finalizers[class_id](JS_GetOpaque(val, class_id));
}

static JSValue qjs_bun_job(JSContext *ctx, int argc, JSValueConst *argv) {
  return JS_Call(ctx, argv[0], JS_UNDEFINED, argc - 1, argv + 1);
}

static JSModuleDef *qjs_bun_module_loader_trampoline(JSContext *ctx, const char *module_name, void *opaque, JSValueConst attributes) {
  return ((QJSBunRuntime *)opaque)->module_loader(ctx, module_name, &attributes);
}

static char *qjs_bun_module_normalizer_trampoline(JSContext *ctx, const char *base_name, const char *name, void *opaque) {
  return ((QJSBunRuntime *)opaque)->module_normalizer(ctx, base_name, name);
}

static void qjs_bun_promise_rejection_trampoline(JSContext *ctx, JSValueConst promise, JSValueConst reason, JS_BOOL is_handled, void *opaque) {
  ((QJSBunPromiseRejectionTracker)opaque)(ctx, &promise, &reason, is_handled);
}

JSRuntime *qjs_bun_new_runtime(void) {
  JSRuntime *rt = JS_NewRuntime();
  if (!rt)
    return NULL;
  QJSBunRuntime *state = malloc(sizeof(*state));
  if (!state) {
    JS_FreeRuntime(rt);
    return NULL;
  }
  memset(state, 0, sizeof(*state));
  state->deadline_ms = INFINITY;
  if (qjs_bun_host_class_id == 0)
    JS_NewClassID(&qjs_bun_host_class_id);
  JSClassDef host_class = {"HostFunction", qjs_bun_host_finalizer, NULL, qjs_bun_host_call, NULL};
  if (JS_NewClass(rt, qjs_bun_host_class_id, &host_class) < 0) {
    free(state);
    JS_FreeRuntime(rt);
    return NULL;
  }
  JS_SetInterruptHandler(rt, qjs_bun_interrupt, state);
  return rt;
}

void qjs_bun_free_runtime(JSRuntime *rt) {
  QJSBunRuntime *state = qjs_bun_state(rt);
  JS_SetModuleLoaderFunc(rt, NULL, NULL, NULL);
  JS_SetHostPromiseRejectionTracker(rt, NULL, NULL);
  JS_FreeRuntime(rt);
  if (!state)
    return;
  while (state->contexts) {
    QJSBunContext *entry = state->contexts;
    state->contexts = entry->next;
    free(entry);
  }
  free(state->finalizers);
  free(state);
}

int qjs_bun_new_class(JSRuntime *rt, uint32_t class_id, const char *name, QJSBunClassFinalizer finalizer) {
  QJSBunRuntime *state = qjs_bun_state(rt);
  if (finalizer && state && class_id >= state->finalizer_count) {
    uint32_t count = class_id + 1;
    QJSBunClassFinalizer *finalizers = realloc(state->finalizers, sizeof(*finalizers) * count);
    if (!finalizers)
      return -1;
    memset(finalizers + state->finalizer_count, 0, sizeof(*finalizers) * (count - state->finalizer_count));
    state->finalizers = finalizers;
    state->finalizer_count = count;
  }
  if (finalizer && state)
    state->finalizers[class_id] = finalizer;
  JSClassDef def = {name, finalizer ? qjs_bun_class_finalize : NULL, NULL, NULL, NULL};
  return JS_NewClass(rt, class_id, &def);
}

void qjs_bun_set_module_loader(JSRuntime *rt, QJSBunModuleLoader loader, QJSBunModuleNormalizer normalizer) {
  QJSBunRuntime *state = qjs_bun_state(rt);
  if (!state)
    return;
  state->module_loader = loader;
  state->module_normalizer = normalizer;
  JS_SetModuleLoaderFunc2(rt, normalizer ? qjs_bun_module_normalizer_trampoline : NULL, loader ? qjs_bun_module_loader_trampoline : NULL, NULL, state);
}

void qjs_bun_set_promise_rejection_tracker(JSRuntime *rt, QJSBunPromiseRejectionTracker tracker) {
  JS_SetHostPromiseRejectionTracker(rt, tracker ? qjs_bun_promise_rejection_trampoline : NULL, tracker);
}

int qjs_bun_execute_pending_job(JSRuntime *rt, double timeout_ms, JSContext **pctx) {
  QJSBunScope scope = qjs_bun_enter(rt, timeout_ms);
  int ret = JS_ExecutePendingJob(rt, pctx);
  if (scope.state) {
    scope.state->deadline_ms = scope.saved_ms;
    if (ret < 0 && *pctx && qjs_bun_now_ms() >= scope.own_ms)
      qjs_bun_throw_timeout(*pctx);
  }
  return ret;
}

JSContext *qjs_bun_new_context(JSRuntime *rt, int raw, double timeout_ms) {
  JSContext *ctx = raw ? JS_NewContextRaw(rt) : JS_NewContext(rt);
  if (!ctx)
    return NULL;
  if (!raw)
    qjs_bun_hide_atomics(ctx);
  QJSBunRuntime *state = qjs_bun_state(rt);
  if (state) {
    QJSBunContext *entry = malloc(sizeof(*entry));
    if (!entry) {
      JS_FreeContext(ctx);
      return NULL;
    }
    entry->ctx = ctx;
    entry->timeout_ms = timeout_ms;
    entry->next = state->contexts;
    state->contexts = entry;
  }
  return ctx;
}

void qjs_bun_free_context(JSContext *ctx) {
  QJSBunRuntime *state = qjs_bun_state(ctx->rt);
  if (state) {
    for (QJSBunContext **link = &state->contexts; *link; link = &(*link)->next) {
      if ((*link)->ctx == ctx) {
        QJSBunContext *entry = *link;
        *link = entry->next;
        free(entry);
        break;
      }
    }
  }
  JS_FreeContext(ctx);
}

int qjs_bun_add_intrinsic(JSContext *ctx, int intrinsic) {
  switch (intrinsic) {
  case 0:
    return JS_AddIntrinsicBaseObjects(ctx);
  case 1:
    return JS_AddIntrinsicDate(ctx);
  case 2:
    return JS_AddIntrinsicEval(ctx);
  case 3:
    return JS_AddIntrinsicStringNormalize(ctx);
  case 4:
    return JS_AddIntrinsicRegExp(ctx);
  case 5:
    JS_AddIntrinsicRegExpCompiler(ctx);
    return 0;
  case 6:
    return JS_AddIntrinsicJSON(ctx);
  case 7:
    return JS_AddIntrinsicProxy(ctx);
  case 8:
    return JS_AddIntrinsicMapSet(ctx);
  case 9: {
    int ret = JS_AddIntrinsicTypedArrays(ctx);
    if (ret >= 0)
      qjs_bun_hide_atomics(ctx);
    return ret;
  }
  case 10:
    return JS_AddIntrinsicPromise(ctx);
  case 11:
    return JS_AddIntrinsicWeakRef(ctx);
  default:
    return -1;
  }
}

int qjs_bun_set_import_meta(JSContext *ctx, const JSValue *v, int is_main) {
  if (JS_VALUE_GET_TAG(*v) != JS_TAG_MODULE) {
    JS_ThrowTypeError(ctx, "value is not a module");
    return -1;
  }
  JSModuleDef *module = JS_VALUE_GET_PTR(*v);
  JSAtom name_atom = JS_GetModuleName(ctx, module);
  const char *name = JS_AtomToCString(ctx, name_atom);
  JS_FreeAtom(ctx, name_atom);
  if (!name)
    return -1;
  JSValue url;
  if (strchr(name, ':')) {
    url = JS_NewString(ctx, name);
  } else {
    size_t name_len = strlen(name);
    char *owned = js_malloc(ctx, 7 + name_len + 1);
    if (!owned) {
      JS_FreeCString(ctx, name);
      return -1;
    }
    memcpy(owned, "file://", 7);
    memcpy(owned + 7, name, name_len + 1);
    url = JS_NewString(ctx, owned);
    js_free(ctx, owned);
  }
  JS_FreeCString(ctx, name);
  if (JS_IsException(url))
    return -1;
  JSValue meta = JS_GetImportMeta(ctx, module);
  if (JS_IsException(meta)) {
    JS_FreeValue(ctx, url);
    return -1;
  }
  int ret = JS_DefinePropertyValueStr(ctx, meta, "url", url, JS_PROP_C_W_E);
  if (ret >= 0)
    ret = JS_DefinePropertyValueStr(ctx, meta, "main", JS_NewBool(ctx, is_main), JS_PROP_C_W_E);
  JS_FreeValue(ctx, meta);
  return ret < 0 ? -1 : 0;
}

JSModuleDef *qjs_bun_compile_module(JSContext *ctx, const uint8_t *source, uint64_t len, const char *filename) {
  JSValue value = JS_EvalInternal(ctx, ctx->global_obj, (const char *)source, (size_t)len, filename, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY, -1);
  if (JS_IsException(value))
    return NULL;
  if (qjs_bun_set_import_meta(ctx, &value, 0) < 0) {
    JS_FreeValue(ctx, value);
    return NULL;
  }
  JSModuleDef *module = JS_VALUE_GET_PTR(value);
  JS_FreeValue(ctx, value);
  return module;
}

void qjs_bun_eval(JSContext *ctx, JSValue *out, const JSValue *this_val, const uint8_t *source, uint64_t len, const char *filename, int flags, double timeout_ms) {
  QJSBunScope scope = qjs_bun_enter(ctx->rt, timeout_ms);
  int is_module = (flags & JS_EVAL_TYPE_MASK) == JS_EVAL_TYPE_MODULE;
  int compile_only = (flags & JS_EVAL_FLAG_COMPILE_ONLY) != 0;
  *out = JS_EvalInternal(ctx, this_val ? *this_val : ctx->global_obj, (const char *)source, (size_t)len, filename, is_module ? flags | JS_EVAL_FLAG_COMPILE_ONLY : flags, -1);
  if (is_module && !JS_IsException(*out)) {
    if (qjs_bun_set_import_meta(ctx, out, 1) < 0) {
      JS_FreeValue(ctx, *out);
      *out = JS_EXCEPTION;
    } else if (!compile_only) {
      *out = JS_EvalFunctionInternal(ctx, *out, ctx->global_obj, NULL, NULL);
    }
  }
  qjs_bun_leave(ctx, scope, JS_IsException(*out));
}

void qjs_bun_eval_function(JSContext *ctx, JSValue *out, const JSValue *fn, double timeout_ms) {
  QJSBunScope scope = qjs_bun_enter(ctx->rt, timeout_ms);
  *out = JS_EvalFunctionInternal(ctx, JS_DupValue(ctx, *fn), ctx->global_obj, NULL, NULL);
  qjs_bun_leave(ctx, scope, JS_IsException(*out));
}

void qjs_bun_call(JSContext *ctx, JSValue *out, const JSValue *fn, const JSValue *this_val, uint32_t argc, JSValue *argv, double timeout_ms) {
  QJSBunScope scope = qjs_bun_enter(ctx->rt, timeout_ms);
  *out = JS_Call(ctx, *fn, *this_val, (int)argc, argv);
  qjs_bun_leave(ctx, scope, JS_IsException(*out));
}

void qjs_bun_invoke(JSContext *ctx, JSValue *out, const JSValue *this_val, uint32_t atom, uint32_t argc, JSValue *argv, double timeout_ms) {
  QJSBunScope scope = qjs_bun_enter(ctx->rt, timeout_ms);
  *out = JS_Invoke(ctx, *this_val, atom, (int)argc, argv);
  qjs_bun_leave(ctx, scope, JS_IsException(*out));
}

void qjs_bun_call_constructor(JSContext *ctx, JSValue *out, const JSValue *fn, const JSValue *new_target, uint32_t argc, JSValue *argv, double timeout_ms) {
  QJSBunScope scope = qjs_bun_enter(ctx->rt, timeout_ms);
  *out = new_target ? JS_CallConstructor2(ctx, *fn, *new_target, (int)argc, argv) : JS_CallConstructor(ctx, *fn, (int)argc, argv);
  qjs_bun_leave(ctx, scope, JS_IsException(*out));
}

void qjs_bun_new_host_function(JSContext *ctx, JSValue *out, QJSBunHostCallback callback, uint32_t host_id) {
  JSValue fn = JS_NewObjectProtoClass(ctx, ctx->function_proto, qjs_bun_host_class_id);
  if (JS_IsException(fn)) {
    *out = fn;
    return;
  }
  QJSBunHostSlot *slot = js_malloc(ctx, sizeof(*slot));
  if (!slot) {
    JS_FreeValue(ctx, fn);
    *out = JS_EXCEPTION;
    return;
  }
  slot->callback = callback;
  slot->host_id = host_id;
  JS_SetOpaque(fn, slot);
  if (JS_DefinePropertyValue(ctx, fn, JS_ATOM_length, JS_NewInt32(ctx, 0), JS_PROP_CONFIGURABLE) < 0 ||
      JS_DefinePropertyValue(ctx, fn, JS_ATOM_name, JS_AtomToString(ctx, JS_ATOM_empty_string), JS_PROP_CONFIGURABLE) < 0) {
    JS_FreeValue(ctx, fn);
    fn = JS_EXCEPTION;
  }
  *out = fn;
}

int qjs_bun_enqueue_job(JSContext *ctx, uint32_t argc, JSValue *argv) {
  return JS_EnqueueJob(ctx, qjs_bun_job, (int)argc, argv);
}

void qjs_bun_new_array_buffer(JSContext *ctx, JSValue *out, uint8_t *buf, uint64_t len, QJSBunHostCallback callback, uint32_t host_id) {
  QJSBunHostSlot *slot = js_malloc(ctx, sizeof(*slot));
  if (!slot) {
    *out = JS_EXCEPTION;
    return;
  }
  slot->callback = callback;
  slot->host_id = host_id;
  *out = JS_NewArrayBuffer(ctx, buf, (size_t)len, qjs_bun_array_buffer_free, slot, 0);
  if (JS_IsException(*out))
    js_free(ctx, slot);
}

int64_t qjs_bun_to_cstring_copy(JSContext *ctx, const JSValue *v, uint8_t *buf, uint64_t capacity) {
  QJSBunScope scope = qjs_bun_enter(ctx->rt, qjs_bun_timeout(ctx));
  size_t len;
  const char *text = JS_ToCStringLen(ctx, &len, *v);
  if (!text) {
    qjs_bun_leave(ctx, scope, 1);
    return -1;
  }
  if (len <= capacity)
    memcpy(buf, text, len);
  JS_FreeCString(ctx, text);
  qjs_bun_leave(ctx, scope, 0);
  return (int64_t)len;
}

int64_t qjs_bun_own_keys(JSContext *ctx, const JSValue *obj, int flags, uint8_t *buf, uint64_t capacity) {
  QJSBunScope scope = qjs_bun_enter(ctx->rt, qjs_bun_timeout(ctx));
  JSPropertyEnum *tab;
  uint32_t count;
  if (JS_GetOwnPropertyNames(ctx, &tab, &count, *obj, flags) < 0) {
    qjs_bun_leave(ctx, scope, 1);
    return -1;
  }
  uint64_t used = 0;
  int64_t ret = 0;
  for (uint32_t i = 0; i < count; i++) {
    size_t len;
    const char *text = JS_AtomToCStringLen(ctx, &len, tab[i].atom);
    if (!text) {
      ret = -1;
      break;
    }
    if (used + 4 + len <= capacity) {
      uint32_t len32 = (uint32_t)len;
      memcpy(buf + used, &len32, 4);
      memcpy(buf + used + 4, text, len);
    }
    used += 4 + len;
    JS_FreeCString(ctx, text);
  }
  JS_FreePropertyEnum(ctx, tab, count);
  if (ret == 0)
    ret = used <= capacity ? (int64_t)count : -(int64_t)used;
  qjs_bun_leave(ctx, scope, ret == -1);
  return ret;
}

static void qjs_bun_print_write(void *opaque, const char *buf, size_t len) {
  dbuf_put(opaque, (const uint8_t *)buf, len);
}

char *qjs_bun_print(JSContext *ctx, const JSValue *v, int show_hidden, int raw_dump, uint32_t max_depth, uint32_t max_string_length, uint32_t max_item_count, uint64_t *len) {
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
  DynBuf dbuf;
  js_dbuf_init(ctx, &dbuf);
  JS_PrintValue(ctx, qjs_bun_print_write, &dbuf, *v, &options);
  if (dbuf_error(&dbuf)) {
    dbuf_free(&dbuf);
    *len = 0;
    return NULL;
  }
  *len = dbuf.size;
  return (char *)dbuf.buf;
}

char *qjs_bun_dump_memory_usage(JSRuntime *rt, uint64_t *len) {
  *len = 0;
  JSMemoryUsage usage;
  JS_ComputeMemoryUsage(rt, &usage);
  FILE *file = tmpfile();
  if (!file)
    return NULL;
  JS_DumpMemoryUsage(file, &usage, rt);
  long size = fflush(file) == 0 && fseek(file, 0, SEEK_END) == 0 ? ftell(file) : -1;
  char *text = size >= 0 && fseek(file, 0, SEEK_SET) == 0 ? js_malloc_rt(rt, (size_t)size + 1) : NULL;
  if (text && fread(text, 1, (size_t)size, file) != (size_t)size) {
    js_free_rt(rt, text);
    text = NULL;
  }
  fclose(file);
  if (text) {
    text[size] = '\0';
    *len = (uint64_t)size;
  }
  return text;
}

int qjs_bun_type(JSContext *ctx, const JSValue *v) {
  switch (JS_VALUE_GET_NORM_TAG(*v)) {
  case JS_TAG_UNDEFINED:
    return 0;
  case JS_TAG_NULL:
    return 1;
  case JS_TAG_BOOL:
    return 2;
  case JS_TAG_INT:
  case JS_TAG_FLOAT64:
    return 3;
  case JS_TAG_BIG_INT:
  case JS_TAG_SHORT_BIG_INT:
    return 4;
  case JS_TAG_STRING:
  case JS_TAG_STRING_ROPE:
    return 5;
  case JS_TAG_SYMBOL:
    return 6;
  case JS_TAG_OBJECT: {
    if (JS_IsFunction(ctx, *v))
      return 8;
    int is_array = JS_IsArray(ctx, *v);
    if (is_array < 0)
      return -1;
    if (is_array)
      return 9;
    return JS_IsError(ctx, *v) ? 10 : 7;
  }
  default:
    return -2;
  }
}

void qjs_bun_throw_error(JSContext *ctx, int kind, const char *message) {
  switch (kind) {
  case 0:
    JS_ThrowSyntaxError(ctx, "%s", message);
    break;
  case 1:
    JS_ThrowTypeError(ctx, "%s", message);
    break;
  case 2:
    JS_ThrowReferenceError(ctx, "%s", message);
    break;
  case 3:
    JS_ThrowRangeError(ctx, "%s", message);
    break;
  default:
    JS_ThrowInternalError(ctx, "%s", message);
    break;
  }
}

void qjs_bun_get_data_property(JSContext *ctx, const JSValue *obj, uint32_t atom, JSValue *out) {
  QJSBunScope scope = qjs_bun_enter(ctx->rt, qjs_bun_timeout(ctx));
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
    if (JS_GetClassID(current) != JS_CLASS_OBJECT)
      break;
  }
  JS_FreeValue(ctx, current);
  qjs_bun_leave(ctx, scope, JS_IsException(*out));
}

QJS_OUT(qjs_bun_get_exception, (JSContext * ctx, JSValue *out), JS_GetException(ctx))
QJS_OUT(qjs_bun_get_global, (JSContext * ctx, JSValue *out), JS_GetGlobalObject(ctx))
QJS_OUT(qjs_bun_throw, (JSContext * ctx, JSValue *out, const JSValue *v), JS_Throw(ctx, JS_DupValue(ctx, *v)))
QJS_OUT(qjs_bun_throw_out_of_memory, (JSContext * ctx, JSValue *out), JS_ThrowOutOfMemory(ctx))
QJS_OUT(qjs_bun_dup_value, (JSContext * ctx, JSValue *out, const JSValue *v), JS_DupValue(ctx, *v))
QJS_OUT(qjs_bun_dup_value_rt, (JSRuntime * rt, JSValue *out, const JSValue *v), JS_DupValueRT(rt, *v))
void qjs_bun_free_value(JSContext *ctx, const JSValue *v) { JS_FreeValue(ctx, *v); }
void qjs_bun_free_value_rt(JSRuntime *rt, const JSValue *v) { JS_FreeValueRT(rt, *v); }
QJS_OUT(qjs_bun_new_string_len, (JSContext * ctx, JSValue *out, const uint8_t *s, uint64_t len), JS_NewStringLen(ctx, (const char *)s, (size_t)len))
QJS_OUT(qjs_bun_new_atom_string, (JSContext * ctx, JSValue *out, const char *s), JS_NewAtomString(ctx, s))
QJS_OUT(qjs_bun_new_symbol, (JSContext * ctx, JSValue *out, const char *description, int is_global), JS_NewSymbol(ctx, description, is_global))
QJS_OUT(qjs_bun_new_bigint64, (JSContext * ctx, JSValue *out, int64_t v), JS_NewBigInt64(ctx, v))
QJS_OUT(qjs_bun_new_biguint64, (JSContext * ctx, JSValue *out, uint64_t v), JS_NewBigUint64(ctx, v))
QJS_OUT(qjs_bun_new_bigint128, (JSContext * ctx, JSValue *out, uint64_t low, uint64_t high), JS_NewBigInt128(ctx, low, high))
QJS_RET(int, qjs_bun_to_bigint128, (JSContext * ctx, uint64_t *low, uint64_t *high, const JSValue *v), JS_ToBigInt128Sat(ctx, low, high, *v))
QJS_OUT(qjs_bun_new_object, (JSContext * ctx, JSValue *out), JS_NewObject(ctx))
QJS_OUT(qjs_bun_new_object_proto, (JSContext * ctx, JSValue *out, const JSValue *proto), JS_NewObjectProto(ctx, *proto))
QJS_OUT(qjs_bun_new_object_class, (JSContext * ctx, JSValue *out, int class_id), JS_NewObjectClass(ctx, class_id))
QJS_OUT(qjs_bun_new_object_proto_class, (JSContext * ctx, JSValue *out, const JSValue *proto, int class_id), JS_NewObjectProtoClass(ctx, *proto, class_id))
QJS_OUT(qjs_bun_new_array, (JSContext * ctx, JSValue *out), JS_NewArray(ctx))
QJS_OUT(qjs_bun_new_date, (JSContext * ctx, JSValue *out, double epoch_ms), JS_NewDate(ctx, epoch_ms))
QJS_RET(int, qjs_bun_date_value, (JSContext * ctx, double *epoch_ms, const JSValue *v), JS_ThisDateValue(ctx, epoch_ms, *v))
QJS_OUT(qjs_bun_new_error, (JSContext * ctx, JSValue *out), JS_NewError(ctx))
QJS_OUT(qjs_bun_new_promise, (JSContext * ctx, JSValue *out, JSValue *resolving), JS_NewPromiseCapability(ctx, resolving))
QJS_RET(int, qjs_bun_promise_state, (JSContext * ctx, const JSValue *v), JS_PromiseState(ctx, *v))
QJS_OUT(qjs_bun_promise_result, (JSContext * ctx, JSValue *out, const JSValue *v), JS_PromiseResult(ctx, *v))
QJS_OUT(qjs_bun_get_class_proto, (JSContext * ctx, JSValue *out, uint32_t class_id), JS_GetClassProto(ctx, class_id))
void qjs_bun_set_class_proto(JSContext *ctx, uint32_t class_id, const JSValue *proto) { JS_SetClassProto(ctx, class_id, JS_DupValue(ctx, *proto)); }
QJS_RET(uint32_t, qjs_bun_get_class_id, (const JSValue *v), JS_GetClassID(*v))
QJS_RET(int, qjs_bun_is_function, (JSContext * ctx, const JSValue *v), JS_IsFunction(ctx, *v))
QJS_RET(int, qjs_bun_is_constructor, (JSContext * ctx, const JSValue *v), JS_IsConstructor(ctx, *v))
QJS_RET(int, qjs_bun_is_array, (JSContext * ctx, const JSValue *v), JS_IsArray(ctx, *v))
QJS_RET(int, qjs_bun_is_error, (JSContext * ctx, const JSValue *v), JS_IsError(ctx, *v))
QJS_RET(int, qjs_bun_is_live_object, (JSRuntime * rt, const JSValue *v), JS_IsLiveObject(rt, *v))
QJS_RET(int, qjs_bun_strict_eq, (JSContext * ctx, const JSValue *a, const JSValue *b), JS_StrictEq(ctx, *a, *b))
QJS_RET(int, qjs_bun_same_value, (JSContext * ctx, const JSValue *a, const JSValue *b), JS_SameValue(ctx, *a, *b))
QJS_RET(int, qjs_bun_same_value_zero, (JSContext * ctx, const JSValue *a, const JSValue *b), JS_SameValueZero(ctx, *a, *b))
QJS_RET(int, qjs_bun_set_constructor_bit, (JSContext * ctx, const JSValue *fn, int v), JS_SetConstructorBit(ctx, *fn, v))
QJS_GUEST_RET(qjs_bun_set_constructor, (JSContext * ctx, const JSValue *fn, const JSValue *proto), JS_SetConstructor(ctx, *fn, *proto))
void qjs_bun_set_is_html_dda(JSContext *ctx, const JSValue *obj) { JS_SetIsHTMLDDA(ctx, *obj); }
QJS_RET(void *, qjs_bun_get_opaque, (const JSValue *obj, uint32_t class_id), JS_GetOpaque(*obj, class_id))
QJS_RET(void *, qjs_bun_get_opaque2, (JSContext * ctx, const JSValue *obj, uint32_t class_id), JS_GetOpaque2(ctx, *obj, class_id))
QJS_RET(void *, qjs_bun_get_any_opaque, (const JSValue *obj, uint32_t *class_id), JS_GetAnyOpaque(*obj, class_id))
void qjs_bun_set_opaque(const JSValue *obj, void *opaque) { JS_SetOpaque(*obj, opaque); }
QJS_OUT(qjs_bun_atom_to_value, (JSContext * ctx, JSValue *out, uint32_t atom), JS_AtomToValue(ctx, atom))
QJS_OUT(qjs_bun_atom_to_string, (JSContext * ctx, JSValue *out, uint32_t atom), JS_AtomToString(ctx, atom))
uint32_t qjs_bun_value_to_atom(JSContext *ctx, const JSValue *v) {
  QJSBunScope scope = qjs_bun_enter(ctx->rt, qjs_bun_timeout(ctx));
  JSAtom atom = JS_ValueToAtom(ctx, *v);
  qjs_bun_leave(ctx, scope, atom == JS_ATOM_NULL);
  return atom;
}
QJS_RET(const char *, qjs_bun_to_cstring_len, (JSContext * ctx, uint64_t *len, const JSValue *v, int cesu8), JS_ToCStringLen2(ctx, (size_t *)len, *v, cesu8))
QJS_OUT(qjs_bun_parse_json, (JSContext * ctx, JSValue *out, const uint8_t *s, uint64_t len, const char *filename, int flags), JS_ParseJSON2(ctx, (const char *)s, (size_t)len, filename, flags))
QJS_OUT(qjs_bun_read_object, (JSContext * ctx, JSValue *out, const uint8_t *s, uint64_t len, int flags), JS_ReadObject(ctx, s, (size_t)len, flags))
QJS_RET(uint8_t *, qjs_bun_write_object, (JSContext * ctx, uint64_t *size, const JSValue *v, int flags), JS_WriteObject(ctx, (size_t *)size, *v, flags))
QJS_RET(uint8_t *, qjs_bun_write_object2, (JSContext * ctx, uint64_t *size, const JSValue *v, int flags, uint8_t ***sab_tab, uint64_t *sab_tab_len), JS_WriteObject2(ctx, (size_t *)size, *v, flags, sab_tab, (size_t *)sab_tab_len))
QJS_OUT(qjs_bun_new_array_buffer_copy, (JSContext * ctx, JSValue *out, const uint8_t *buf, uint64_t len), JS_NewArrayBufferCopy(ctx, buf, (size_t)len))
QJS_RET(uint8_t *, qjs_bun_get_array_buffer, (JSContext * ctx, uint64_t *size, const JSValue *obj), JS_GetArrayBuffer(ctx, (size_t *)size, *obj))
void qjs_bun_detach_array_buffer(JSContext *ctx, const JSValue *obj) { JS_DetachArrayBuffer(ctx, *obj); }
QJS_OUT(qjs_bun_get_typed_array_buffer, (JSContext * ctx, JSValue *out, const JSValue *obj, uint64_t *byte_offset, uint64_t *byte_length, uint64_t *bytes_per_element), JS_GetTypedArrayBuffer(ctx, *obj, (size_t *)byte_offset, (size_t *)byte_length, (size_t *)bytes_per_element))
QJS_OUT(qjs_bun_get_import_meta, (JSContext * ctx, JSValue *out, JSModuleDef *module), JS_GetImportMeta(ctx, module))
void qjs_bun_get_module_namespace(JSContext *ctx, JSValue *out, JSModuleDef *module) {
  *out = module->func_created ? JS_GetModuleNamespace(ctx, module) : JS_ThrowInternalError(ctx, "module is not instantiated");
}
QJS_OUT(qjs_bun_get_module_private_value, (JSContext * ctx, JSValue *out, JSModuleDef *module), JS_GetModulePrivateValue(ctx, module))
QJS_RET(int, qjs_bun_set_module_private_value, (JSContext * ctx, JSModuleDef *module, const JSValue *v), JS_SetModulePrivateValue(ctx, module, JS_DupValue(ctx, *v)))
int qjs_bun_set_module_export(JSContext *ctx, JSModuleDef *module, const char *name, const JSValue *v) {
  if (!module->func_created) {
    JS_ThrowInternalError(ctx, "module is not instantiated");
    return -1;
  }
  return JS_SetModuleExport(ctx, module, name, JS_DupValue(ctx, *v));
}
QJS_RET(int, qjs_bun_resolve_module, (JSContext * ctx, const JSValue *v), JS_ResolveModule(ctx, *v))
QJS_GUEST_OUT(qjs_bun_load_module, (JSContext * ctx, JSValue *out, const char *basename, const char *filename), JS_LoadModule(ctx, basename, filename))
QJS_GUEST_OUT(qjs_bun_new_typed_array, (JSContext * ctx, JSValue *out, uint32_t argc, JSValue *argv, int type), JS_NewTypedArray(ctx, (int)argc, argv, type))
QJS_GUEST_OUT(qjs_bun_json_stringify, (JSContext * ctx, JSValue *out, const JSValue *v, const JSValue *replacer, const JSValue *space), JS_JSONStringify(ctx, *v, *replacer, *space))
QJS_GUEST_OUT(qjs_bun_to_object, (JSContext * ctx, JSValue *out, const JSValue *v), JS_ToObject(ctx, *v))
QJS_GUEST_OUT(qjs_bun_to_primitive, (JSContext * ctx, JSValue *out, const JSValue *v, int hint), JS_ToPrimitive(ctx, *v, hint))
QJS_GUEST_OUT(qjs_bun_to_string, (JSContext * ctx, JSValue *out, const JSValue *v), JS_ToString(ctx, *v))
QJS_GUEST_OUT(qjs_bun_to_property_key, (JSContext * ctx, JSValue *out, const JSValue *v), JS_ToPropertyKey(ctx, *v))
QJS_GUEST_RET(qjs_bun_to_bool, (JSContext * ctx, const JSValue *v), JS_ToBool(ctx, *v))
QJS_GUEST_RET(qjs_bun_to_float64, (JSContext * ctx, double *res, const JSValue *v), JS_ToFloat64(ctx, res, *v))
QJS_GUEST_RET(qjs_bun_to_int32, (JSContext * ctx, int32_t *res, const JSValue *v), JS_ToInt32(ctx, res, *v))
QJS_GUEST_RET(qjs_bun_to_int32_sat, (JSContext * ctx, int32_t *res, const JSValue *v), JS_ToInt32Sat(ctx, (int *)res, *v))
QJS_GUEST_RET(qjs_bun_to_uint32, (JSContext * ctx, uint32_t *res, const JSValue *v), JS_ToUint32(ctx, res, *v))
QJS_GUEST_RET(qjs_bun_to_int64, (JSContext * ctx, int64_t *res, const JSValue *v), JS_ToInt64(ctx, res, *v))
QJS_GUEST_RET(qjs_bun_to_int64_ext, (JSContext * ctx, int64_t *res, const JSValue *v), JS_ToInt64Ext(ctx, res, *v))
QJS_GUEST_RET(qjs_bun_to_index, (JSContext * ctx, uint64_t *res, const JSValue *v), JS_ToIndex(ctx, res, *v))
QJS_GUEST_RET(qjs_bun_to_bigint64, (JSContext * ctx, int64_t *res, const JSValue *v), JS_ToBigInt64(ctx, res, *v))
QJS_GUEST_RET(qjs_bun_is_instance_of, (JSContext * ctx, const JSValue *v, const JSValue *ctor), JS_IsInstanceOf(ctx, *v, *ctor))
QJS_GUEST_RET(qjs_bun_ordinary_is_instance_of, (JSContext * ctx, const JSValue *v, const JSValue *ctor), JS_OrdinaryIsInstanceOf(ctx, *v, *ctor))
QJS_GUEST_OUT(qjs_bun_create_from_constructor, (JSContext * ctx, JSValue *out, const JSValue *ctor, int class_id), JS_CreateFromConstructor(ctx, *ctor, class_id))
QJS_GUEST_OUT(qjs_bun_get_property, (JSContext * ctx, JSValue *out, const JSValue *obj, uint32_t atom), JS_GetProperty(ctx, *obj, atom))
QJS_GUEST_OUT(qjs_bun_get_property_internal, (JSContext * ctx, JSValue *out, const JSValue *obj, uint32_t atom, const JSValue *receiver, int throw_ref_error), JS_GetPropertyInternal(ctx, *obj, atom, *receiver, throw_ref_error))
QJS_GUEST_OUT(qjs_bun_get_property_u32, (JSContext * ctx, JSValue *out, const JSValue *obj, uint32_t index), JS_GetPropertyUint32(ctx, *obj, index))
QJS_GUEST_RET(qjs_bun_set_property, (JSContext * ctx, const JSValue *obj, uint32_t atom, const JSValue *v), JS_SetProperty(ctx, *obj, atom, JS_DupValue(ctx, *v)))
QJS_GUEST_RET(qjs_bun_set_property_internal, (JSContext * ctx, const JSValue *obj, uint32_t atom, const JSValue *v, const JSValue *receiver, int flags), JS_SetPropertyInternal(ctx, *obj, atom, JS_DupValue(ctx, *v), *receiver, flags))
QJS_GUEST_RET(qjs_bun_set_property_u32, (JSContext * ctx, const JSValue *obj, uint32_t index, const JSValue *v), JS_SetPropertyUint32(ctx, *obj, index, JS_DupValue(ctx, *v)))
QJS_GUEST_RET(qjs_bun_set_property_i64, (JSContext * ctx, const JSValue *obj, int64_t index, const JSValue *v), JS_SetPropertyInt64(ctx, *obj, index, JS_DupValue(ctx, *v)))
QJS_GUEST_RET(qjs_bun_has_property, (JSContext * ctx, const JSValue *obj, uint32_t atom), JS_HasProperty(ctx, *obj, atom))
QJS_GUEST_RET(qjs_bun_delete_property, (JSContext * ctx, const JSValue *obj, uint32_t atom, int flags), JS_DeleteProperty(ctx, *obj, atom, flags))
QJS_GUEST_RET(qjs_bun_define_property, (JSContext * ctx, const JSValue *obj, uint32_t atom, const JSValue *v, const JSValue *getter, const JSValue *setter, int flags), JS_DefineProperty(ctx, *obj, atom, *v, *getter, *setter, flags))
QJS_GUEST_RET(qjs_bun_define_property_value, (JSContext * ctx, const JSValue *obj, uint32_t atom, const JSValue *v, int flags), JS_DefinePropertyValue(ctx, *obj, atom, JS_DupValue(ctx, *v), flags))
QJS_GUEST_RET(qjs_bun_define_property_value_u32, (JSContext * ctx, const JSValue *obj, uint32_t index, const JSValue *v, int flags), JS_DefinePropertyValueUint32(ctx, *obj, index, JS_DupValue(ctx, *v), flags))
QJS_GUEST_RET(qjs_bun_define_property_get_set, (JSContext * ctx, const JSValue *obj, uint32_t atom, const JSValue *getter, const JSValue *setter, int flags), JS_DefinePropertyGetSet(ctx, *obj, atom, JS_DupValue(ctx, *getter), JS_DupValue(ctx, *setter), flags))
QJS_GUEST_RET(qjs_bun_get_own_property, (JSContext * ctx, JSPropertyDescriptor *desc, const JSValue *obj, uint32_t atom), JS_GetOwnProperty(ctx, desc, *obj, atom))
QJS_GUEST_RET(qjs_bun_get_own_property_names, (JSContext * ctx, JSPropertyEnum **tab, uint32_t *len, const JSValue *obj, int flags), JS_GetOwnPropertyNames(ctx, tab, len, *obj, flags))
QJS_GUEST_OUT(qjs_bun_get_prototype, (JSContext * ctx, JSValue *out, const JSValue *obj), JS_GetPrototype(ctx, *obj))
QJS_GUEST_RET(qjs_bun_set_prototype, (JSContext * ctx, const JSValue *obj, const JSValue *proto), JS_SetPrototype(ctx, *obj, *proto))
QJS_GUEST_RET(qjs_bun_is_extensible, (JSContext * ctx, const JSValue *obj), JS_IsExtensible(ctx, *obj))
QJS_GUEST_RET(qjs_bun_prevent_extensions, (JSContext * ctx, const JSValue *obj), JS_PreventExtensions(ctx, *obj))
QJS_GUEST_OUT(qjs_bun_get_iterator, (JSContext * ctx, JSValue *out, const JSValue *obj, int is_async), JS_GetIterator(ctx, *obj, is_async))
QJS_GUEST_OUT(qjs_bun_iterator_next, (JSContext * ctx, JSValue *out, const JSValue *iterator, const JSValue *method, int32_t *done), JS_IteratorNext(ctx, *iterator, *method, done))
QJS_GUEST_RET(qjs_bun_iterator_close, (JSContext * ctx, const JSValue *iterator, int is_exception_pending), JS_IteratorClose(ctx, *iterator, is_exception_pending))

#define QJS_BUN_SYMBOLS(X) \
  X(JS_NewRuntime) X(JS_FreeRuntime) X(qjs_bun_new_runtime) X(qjs_bun_free_runtime) \
  X(JS_SetRuntimeInfo) X(JS_SetMemoryLimit) X(JS_SetGCThreshold) X(JS_SetMaxStackSize) X(JS_UpdateStackTop) X(JS_RunGC) \
  X(JS_SetRuntimeOpaque) X(JS_GetRuntimeOpaque) X(JS_ComputeMemoryUsage) X(qjs_bun_dump_memory_usage) \
  X(JS_SetCanBlock) X(JS_SetStripInfo) X(JS_GetStripInfo) X(JS_IsJobPending) X(qjs_bun_execute_pending_job) \
  X(JS_NewClassID) X(JS_NewClass) X(qjs_bun_new_class) X(JS_IsRegisteredClass) \
  X(qjs_bun_set_module_loader) X(qjs_bun_set_promise_rejection_tracker) X(JS_SetSharedArrayBufferFunctions) \
  X(JS_FreeAtomRT) X(qjs_bun_dup_value_rt) X(qjs_bun_free_value_rt) X(qjs_bun_is_live_object) \
  X(JS_NewContext) X(JS_NewContextRaw) X(JS_FreeContext) X(JS_DupContext) X(JS_GetRuntime) X(qjs_bun_new_context) X(qjs_bun_free_context) \
  X(JS_SetContextOpaque) X(JS_GetContextOpaque) X(qjs_bun_add_intrinsic) \
  X(JS_AddIntrinsicBaseObjects) X(JS_AddIntrinsicDate) X(JS_AddIntrinsicEval) X(JS_AddIntrinsicStringNormalize) X(JS_AddIntrinsicRegExpCompiler) \
  X(JS_AddIntrinsicRegExp) X(JS_AddIntrinsicJSON) X(JS_AddIntrinsicProxy) X(JS_AddIntrinsicMapSet) X(JS_AddIntrinsicTypedArrays) \
  X(JS_AddIntrinsicPromise) X(JS_AddIntrinsicWeakRef) \
  X(qjs_bun_get_global) X(qjs_bun_get_class_proto) X(qjs_bun_set_class_proto) X(JS_GetScriptOrModuleName) \
  X(qjs_bun_eval) X(qjs_bun_eval_function) X(qjs_bun_call) X(qjs_bun_invoke) X(qjs_bun_call_constructor) X(JS_DetectModule) \
  X(qjs_bun_parse_json) X(qjs_bun_json_stringify) X(qjs_bun_read_object) X(qjs_bun_write_object) X(qjs_bun_write_object2) \
  X(qjs_bun_get_exception) X(JS_HasException) X(qjs_bun_throw) X(qjs_bun_throw_error) X(qjs_bun_throw_out_of_memory) X(JS_SetUncatchableException) \
  X(qjs_bun_dup_value) X(qjs_bun_free_value) X(qjs_bun_type) X(qjs_bun_get_class_id) \
  X(qjs_bun_new_string_len) X(qjs_bun_to_cstring_copy) X(qjs_bun_to_cstring_len) X(JS_FreeCString) \
  X(qjs_bun_new_bigint64) X(qjs_bun_new_biguint64) X(qjs_bun_new_bigint128) X(qjs_bun_to_bigint128) X(qjs_bun_new_symbol) \
  X(qjs_bun_new_object) X(qjs_bun_new_object_proto) X(qjs_bun_new_object_class) X(qjs_bun_new_object_proto_class) X(qjs_bun_new_array) \
  X(qjs_bun_new_date) X(qjs_bun_date_value) X(qjs_bun_new_error) X(qjs_bun_new_promise) X(qjs_bun_promise_state) X(qjs_bun_promise_result) \
  X(qjs_bun_new_host_function) X(qjs_bun_enqueue_job) X(qjs_bun_new_atom_string) \
  X(qjs_bun_to_object) X(qjs_bun_to_primitive) X(qjs_bun_to_string) X(qjs_bun_to_property_key) X(qjs_bun_to_bool) X(qjs_bun_to_float64) \
  X(qjs_bun_to_int32) X(qjs_bun_to_int32_sat) X(qjs_bun_to_uint32) X(qjs_bun_to_int64) X(qjs_bun_to_int64_ext) X(qjs_bun_to_index) X(qjs_bun_to_bigint64) \
  X(qjs_bun_strict_eq) X(qjs_bun_same_value) X(qjs_bun_same_value_zero) \
  X(qjs_bun_is_function) X(qjs_bun_is_constructor) X(qjs_bun_is_array) X(qjs_bun_is_error) X(qjs_bun_is_instance_of) X(qjs_bun_ordinary_is_instance_of) \
  X(qjs_bun_set_constructor_bit) X(qjs_bun_set_constructor) X(qjs_bun_set_is_html_dda) X(qjs_bun_create_from_constructor) \
  X(qjs_bun_get_property) X(qjs_bun_get_property_internal) X(qjs_bun_get_data_property) X(qjs_bun_get_property_u32) \
  X(qjs_bun_set_property) X(qjs_bun_set_property_internal) X(qjs_bun_set_property_u32) X(qjs_bun_set_property_i64) \
  X(qjs_bun_has_property) X(qjs_bun_delete_property) X(qjs_bun_define_property) X(qjs_bun_define_property_value) \
  X(qjs_bun_define_property_value_u32) X(qjs_bun_define_property_get_set) X(qjs_bun_get_own_property) X(qjs_bun_get_own_property_names) \
  X(JS_FreePropertyEnum) X(qjs_bun_own_keys) X(qjs_bun_get_prototype) X(qjs_bun_set_prototype) X(qjs_bun_is_extensible) X(qjs_bun_prevent_extensions) \
  X(JS_NewAtomLen) X(JS_NewAtom) X(JS_NewAtomUInt32) X(JS_DupAtom) X(JS_FreeAtom) X(JS_AtomToCStringLen) \
  X(qjs_bun_atom_to_value) X(qjs_bun_atom_to_string) X(qjs_bun_value_to_atom) \
  X(qjs_bun_get_opaque) X(qjs_bun_get_opaque2) X(qjs_bun_get_any_opaque) X(qjs_bun_set_opaque) \
  X(qjs_bun_new_array_buffer) X(qjs_bun_new_array_buffer_copy) X(qjs_bun_get_array_buffer) X(qjs_bun_detach_array_buffer) \
  X(qjs_bun_new_typed_array) X(qjs_bun_get_typed_array_buffer) \
  X(qjs_bun_get_iterator) X(qjs_bun_iterator_next) X(qjs_bun_iterator_close) \
  X(JS_NewCModule) X(JS_AddModuleExport) X(qjs_bun_set_module_export) X(JS_GetModuleName) X(qjs_bun_get_import_meta) \
  X(qjs_bun_get_module_namespace) X(qjs_bun_get_module_private_value) X(qjs_bun_set_module_private_value) \
  X(qjs_bun_resolve_module) X(qjs_bun_load_module) X(qjs_bun_compile_module) X(qjs_bun_set_import_meta) \
  X(qjs_bun_print) X(qjs_bun_timeout_error) X(qjs_bun_enter_scope) X(qjs_bun_leave_scope) X(js_malloc) X(js_free) X(js_malloc_rt) X(js_free_rt)

#define QJS_BUN_SYMBOL_ENTRY(name) {#name, (const void *)name},
static const struct {
  const char *name;
  const void *ptr;
} qjs_bun_symbols[] = {QJS_BUN_SYMBOLS(QJS_BUN_SYMBOL_ENTRY)};

const void *qjs_bun_symbol(const char *name) {
  for (size_t i = 0; i < sizeof(qjs_bun_symbols) / sizeof(qjs_bun_symbols[0]); i++)
    if (strcmp(qjs_bun_symbols[i].name, name) == 0)
      return qjs_bun_symbols[i].ptr;
  return NULL;
}
