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

#include "../../quickjs/quickjs.c"
#include "quickjs_bridge.c"
