#if defined(__TINYC__)
#include <stdlib.h>
static void qjs_bun_abort(void) { abort(); }
#define abort() for (;;) qjs_bun_abort()
#if defined(__linux__)
void *__dso_handle;
#endif
int __builtin_clz(unsigned int v) { int n = 0; for (; n < 32 && !(v & 0x80000000u); n++) v <<= 1; return n; }
int __builtin_clzll(unsigned long long v) { int n = 0; for (; n < 64 && !(v & 0x8000000000000000ull); n++) v <<= 1; return n; }
int __builtin_ctz(unsigned int v) { int n = 0; for (; n < 32 && !(v & 1u); n++) v >>= 1; return n; }
int __builtin_ctzll(unsigned long long v) { int n = 0; for (; n < 64 && !(v & 1ull); n++) v >>= 1; return n; }
#if defined(__aarch64__)
static void *qjs_bun_frame_address(int level) {
  char stack;
  (void)level;
  return &stack;
}
#define __builtin_frame_address(level) qjs_bun_frame_address(level)
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

#include "../../quickjs/quickjs.c"
#include "quickjs_bridge.c"
