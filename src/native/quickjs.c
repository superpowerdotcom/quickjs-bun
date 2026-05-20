#if defined(__TINYC__)
#include <stdlib.h>
/* Keep Bun/TCC compatibility here so vendored QuickJS stays untouched. */
#if defined(__linux__)
#define QJS_BUN_TCC_LINUX 1
#endif
#if defined(__aarch64__)
#define QJS_BUN_TCC_ARM64 1
#if defined(QJS_BUN_TCC_LINUX)
#define QJS_BUN_TCC_LINUX_ARM64 1
#endif
#endif
static void qjs_bun_abort(void) { abort(); }
#define abort() for (;;) qjs_bun_abort()
#if defined(__aarch64__)
static void *qjs_bun_frame_address(int level) {
  char stack;
  (void)level;
  return &stack;
}
#define __builtin_frame_address(level) qjs_bun_frame_address(level)
#endif
#if defined(__linux__)
void *__dso_handle;
#endif
int __builtin_clz(unsigned int v) { int n = 0; for (; n < 32 && !(v & 0x80000000u); n++) v <<= 1; return n; }
int __builtin_clzll(unsigned long long v) { int n = 0; for (; n < 64 && !(v & 0x8000000000000000ull); n++) v <<= 1; return n; }
int __builtin_ctz(unsigned int v) { int n = 0; for (; n < 32 && !(v & 1u); n++) v >>= 1; return n; }
int __builtin_ctzll(unsigned long long v) { int n = 0; for (; n < 64 && !(v & 1ull); n++) v >>= 1; return n; }
#if defined(__aarch64__)
/* Preload system headers, then hide arm64 so QuickJS avoids unsupported TCC asm. */
#include <assert.h>
#include <fenv.h>
#include <inttypes.h>
#include <math.h>
#if defined(__APPLE__)
#include <malloc/malloc.h>
#elif defined(__linux__) || defined(__GLIBC__)
#include <malloc.h>
#endif
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#undef __aarch64__
#endif
#endif

#if defined(__TINYC__) && defined(_WIN32)
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <sys/time.h>
#include <time.h>
#undef NAN
#define NAN (0.0 / 0.0)
#undef INFINITY
#define INFINITY (1.0 / 0.0)
#define __builtin_trap() (qjs_bun_abort(), 0)
#undef alloca
#undef _alloca
void *_alloca(size_t size);
#define alloca _alloca

const double __QNANF = 0.0 / 0.0;

static int qjs_bun_is_nan(double x) { return x != x; }
int __isnan(double x) { return qjs_bun_is_nan(x); }
int __isnanf(float x) { return x != x; }
int __signbit(double x) {
  union {
    double f;
    unsigned long long i;
  } value = {x};
  return (int)(value.i >> 63);
}
int __fpclassify(double x) {
  if (qjs_bun_is_nan(x))
    return FP_NAN;
  if (x == INFINITY || x == -INFINITY)
    return FP_INFINITE;
  if (x == 0)
    return FP_ZERO;
  return FP_NORMAL;
}

double round(double x) { return x < 0 ? ceil(x - 0.5) : floor(x + 0.5); }
double trunc(double x) { return x < 0 ? ceil(x) : floor(x); }
long lrint(double x) { return (long)round(x); }
double fmin(double x, double y) { return qjs_bun_is_nan(x) || y < x ? y : x; }
double fmax(double x, double y) { return qjs_bun_is_nan(x) || y > x ? y : x; }
double acosh(double x) { return log(x + sqrt(x * x - 1)); }
double asinh(double x) { return log(x + sqrt(x * x + 1)); }
double atanh(double x) { return 0.5 * log((1 + x) / (1 - x)); }
double expm1(double x) { return exp(x) - 1; }
double log1p(double x) { return log(1 + x); }
double log2(double x) { return log(x) / log(2); }
double cbrt(double x) { return x < 0 ? -pow(-x, 1.0 / 3.0) : pow(x, 1.0 / 3.0); }

int gettimeofday(struct timeval *tv, void *tz) {
  (void)tz;
  tv->tv_sec = (long)time(NULL);
  tv->tv_usec = 0;
  return 0;
}

int _vsnprintf(char *buffer, size_t size, const char *format, va_list args);
int __ms_vsnprintf(char *buffer, size_t size, const char *format, va_list args) {
  return _vsnprintf(buffer, size, format, args);
}

FILE *__iob_func(void);
FILE *__acrt_iob_func(unsigned index) {
  return __iob_func() + index;
}
#endif

/* QuickJS gates Atomics on !__EMSCRIPTEN__; set it only while including QuickJS. */
#if !defined(__EMSCRIPTEN__)
#define __EMSCRIPTEN__ 1
#define QJS_BUN_RESTORE_EMSCRIPTEN 1
#endif
#define CONFIG_STACK_CHECK 1
#define QJS_BUN_TRACKED_ALLOC 1
#if defined(QJS_BUN_TRACKED_ALLOC)
#define JS_NewRuntime qjs_bun_quickjs_new_runtime
#endif
#include "../../quickjs/quickjs.c"
#if defined(QJS_BUN_TRACKED_ALLOC)
#undef JS_NewRuntime
#endif
#if defined(QJS_BUN_RESTORE_EMSCRIPTEN)
#undef __EMSCRIPTEN__
#undef QJS_BUN_RESTORE_EMSCRIPTEN
#endif

#if defined(QJS_BUN_TRACKED_ALLOC)
#undef malloc
#undef free
#undef realloc
/* Memory limits and usage should not depend on platform malloc_usable_size/_msize behavior. */
typedef struct QJSBunAllocHeader {
  size_t size;
} QJSBunAllocHeader;

static void *qjs_bun_malloc(JSMallocState *state, size_t size) {
  QJSBunAllocHeader *header;
  if (state->malloc_size + size > state->malloc_limit)
    return NULL;
  header = malloc(sizeof(*header) + size);
  if (!header)
    return NULL;
  header->size = size;
  state->malloc_count++;
  state->malloc_size += size + MALLOC_OVERHEAD;
  return header + 1;
}

static void qjs_bun_free(JSMallocState *state, void *ptr) {
  QJSBunAllocHeader *header;
  if (!ptr)
    return;
  header = (QJSBunAllocHeader *)ptr - 1;
  state->malloc_count--;
  state->malloc_size -= header->size + MALLOC_OVERHEAD;
  free(header);
}

static void *qjs_bun_realloc(JSMallocState *state, void *ptr, size_t size) {
  QJSBunAllocHeader *header;
  size_t old_size;
  if (!ptr)
    return size ? qjs_bun_malloc(state, size) : NULL;
  header = (QJSBunAllocHeader *)ptr - 1;
  old_size = header->size;
  if (size == 0) {
    qjs_bun_free(state, ptr);
    return NULL;
  }
  if (state->malloc_size + size - old_size > state->malloc_limit)
    return NULL;
  header = realloc(header, sizeof(*header) + size);
  if (!header)
    return NULL;
  header->size = size;
  state->malloc_size += size - old_size;
  return header + 1;
}

static size_t qjs_bun_malloc_usable_size(const void *ptr) {
  return ptr ? (((const QJSBunAllocHeader *)ptr) - 1)->size : 0;
}
static JSRuntime *qjs_bun_new_runtime(void) {
  JSMallocFunctions functions = {
    qjs_bun_malloc,
    qjs_bun_free,
    qjs_bun_realloc,
    qjs_bun_malloc_usable_size,
  };
  return JS_NewRuntime2(&functions, NULL);
}

JSRuntime *JS_NewRuntime(void) {
  return qjs_bun_new_runtime();
}
#endif

/* Keep the bridge in this translation unit so Windows/TCC avoids JSValue ABI return edges. */
#include "quickjs_bridge.c"
