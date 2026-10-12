# quickjs-bun

Lightweight, fully-featured, idiomatic [bun:ffi](https://bun.com/docs/runtime/ffi) bindings to [QuickJS](https://bellard.org/quickjs/).

[QuickJS](https://bellard.org/quickjs/) is a small, fast, embeddable JavaScript engine by [Fabrice Bellard](https://en.wikipedia.org/wiki/Fabrice_Bellard) with near-complete ES2023 support, modules, async generators, proxies, and strict sandboxing controls (memory limits, stack limits, interrupts), all without external dependencies. `quickjs-bun` vendors QuickJS `2026-06-04` and maps its whole C API to Bun.

## Why

Running untrusted JavaScript inside a Bun process usually means Node-API wrappers, leaked C handles, or sharing the host isolate. `quickjs-bun` instead:

- compiles QuickJS on the fly with Bun's embedded TinyCC and binds every function through Bun 1.4's engine-native FFI path, so a call into QuickJS costs single-digit nanoseconds;
- keeps every guest value behind a `JSValue` handle with deterministic reference counting and [`using`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html#using-declarations-and-explicit-resource-management) support;
- enforces memory, stack, and time limits inside C, so hostile guest code cannot hang or crash the host, whichever API it reaches through.

## Requirements

Bun 1.4 or newer. On macOS and Linux (x86_64 and aarch64) the C sources compile at `new QuickJS()` with Bun's embedded TinyCC, which only needs the C library headers (`apk add musl-dev` on Alpine, `apt-get install libc6-dev` on Debian; macOS has them). Windows, and any machine without headers, needs a prebuilt library (see below).

```bash
bun add quickjs-bun
```

## Usage

```typescript
import { JSRuntime, QuickJS } from "quickjs-bun";

using library = new QuickJS();
using runtime = new JSRuntime({ library, memoryBytes: 32 * 1024 * 1024 });
using vm = runtime.createContext({ timeoutMs: 100 });

using result = vm.evalCode("[1, 2, 3].map((x) => x * 2)");
console.log(vm.dump(result)); // [2, 4, 6]
```

`JSValue`, `JSAtom`, `JSContext`, `JSRuntime`, and `QuickJS` all implement `Symbol.dispose`. Call `.dispose()` yourself on anything that outlives its scope; a handle that is never disposed keeps its guest object alive until its context is disposed, at which point the context releases every handle it still tracks (`vm.handles`).

### Limits

```typescript
using runtime = new JSRuntime({ library, memoryBytes: 1024 * 1024, stackBytes: 64 * 1024 });
using vm = runtime.createContext({ timeoutMs: 25 });

vm.evalCode("while (true) {}"); // throws TimeoutError: QuickJS execution timed out
vm.evalCode("const a = []; while (true) a.push('x'.repeat(1e4))"); // throws InternalError: out of memory
vm.evalCode("(function f() { return f() + 1 })()"); // throws InternalError: stack overflow
```

`timeoutMs` applies to every operation that can run guest code: evaluation, calls, property access, coercions, JSON, iteration, dumps, and jobs. A getter or proxy trap that spins is interrupted just like a top-level loop. `evalCode` and `executePendingJob` accept a per-call `timeoutMs`.

`stackBytes` bounds the native stack the guest may use, so the recursion depth it allows depends on how the engine was compiled: about 1,150 nested calls per MiB with an optimized build and about 130 with TinyCC, whose unoptimized interpreter frames are far larger. Size it for the build you ship and for the deepest recursion you expect.

### Converting values

```typescript
using user = vm.newValue({ name: "Alice", scores: [10, 20, 30] });
vm.setGlobal("user", user);
using total = vm.evalCode("user.scores.reduce((a, b) => a + b, 0)");
vm.dump(total); // 60
```

`newValue` accepts `undefined`, `null`, booleans, numbers, bigints, strings, `Error`s, plain objects, arrays, and existing `JSValue`s. Plain JSON trees are parsed by QuickJS in one call. `dump` is the inverse: it walks guest objects by identity (cycles survive), converts errors to `Error`, bigints to `bigint`, and refuses functions and symbols. It reads own enumerable properties only, so a `Date`, `Map`, `Set`, or typed array comes back as a plain object; use `toDate`, `arrayBufferBytes`, or convert such values in the guest first. `JSValue` also offers typed accessors (`toNumber`, `toString`, `toBigInt`, `toBoolean`, `toError`, `toDate`), coercions (`coerceToNumber`, `coerceToString`, `coerceToPrimitive`, ...), and `print()` for QuickJS's own inspector output.

### Host functions

```typescript
using add = vm.newFunction((left, right) => left.toNumber() + right.toNumber());
vm.setGlobal("add", add);
using sum = vm.evalCode("add(20, 22)"); // 42
```

A host function receives owned `JSValue` arguments that are disposed when it returns. It may return a plain host value, a `JSValue` (ownership moves to the guest), or throw: a host `Error` becomes a guest error, and a thrown `JSValue` or `JSException` is rethrown as that exact guest value. QuickJS releases the host closure when the guest drops the function.

### Promises and the job queue

QuickJS has no event loop. Host promises are bridged with `newPromise`, and the host drives microtasks with `executePendingJob`:

```typescript
using deferred = vm.newPromise();
vm.setGlobal("pending", deferred.promise);
using chained = vm.evalCode("pending.then((value) => value + 1)");

using value = vm.newNumber(41);
deferred.resolve(value);
runtime.executePendingJobs();
using result = chained.promiseResult(); // 42
```

Pass `QuickJSEvalFlags.ASYNC` to `evalCode` for top-level `await`; the result is a promise whose fulfillment value is `{ value }`. `examples/sandbox` shows a complete loop that interleaves guest jobs with host timers. `executePendingJobs` runs until the queue is empty, which a guest can postpone forever by scheduling a microtask from every microtask; when the code is untrusted, call `executePendingJob` yourself and cap the count.

### Modules

```typescript
runtime.setModuleLoader(
  (name) => (name === "virtual:math" ? "export const answer = 42;" : undefined),
  (base, name) => (name.startsWith("virtual:") ? name : `virtual:${name}`),
);
vm.evalCode('import { answer } from "math"; globalThis.answer = answer;', {
  filename: "main.js",
  flags: QuickJSEvalFlags.TYPE_MODULE,
});
```

The loader may return source text, bytes, a `JSModule` from `vm.newCModule(name, init)`, or `undefined` to fail the import. The optional normalizer rewrites specifiers before loading. `compileCode` plus `evalFunction` run precompiled code, and `writeObject` / `readObject` serialize values and bytecode.

### Classes, opaque pointers, and finalizers

```typescript
const classId = runtime.registerClass("Handle", { finalizer: (opaque) => release(opaque) });
using handle = vm.newObjectClass(classId);
handle.setOpaque(ptr);
handle.getOpaque(classId); // ptr
```

The finalizer runs with the opaque pointer when QuickJS frees the object. `setClassProto` and `newObjectProtoClass` wire prototypes; `setConstructorBit` and `setConstructor` make host functions usable with `new`.

### Everything else

- `for (const item of handle)` iterates any guest iterable; each yielded `JSValue` is owned.
- `getProp`, `setProp`, `defineProp`, `hasProp`, `deleteProp`, `getOwnPropertyDescriptor`, and `defineProperty` take string, numeric, or `JSAtom` keys. `keys` returns the enumerable string keys; `ownAtoms` also returns symbols.
- `newArrayBuffer(view)` shares host memory with the guest without copying; the view is pinned until QuickJS frees the buffer, and its `ArrayBuffer` must not be resized or transferred meanwhile. `newArrayBufferCopy`, `newTypedArray`, `typedArrayInfo`, and `arrayBufferBytes` cover the copying variants.
- `newSymbol`, `newDate`, `newBigInt` (any size), `newAtom`, `JSAtom.toValue()`.
- `runtime.setPromiseRejectionTracker`, `runtime.memoryUsage()`, `runtime.dumpMemoryUsage()`, `runtime.runGC()`, `setStripInfo`, `setCanBlock`, `setRuntimeInfo`.
- `vm.addIntrinsics([...])` on a context created with `intrinsics: "minimal"` picks which built-ins exist.

### Escape hatches

`library.native` exposes every bound C function with its exact signature, and `runtime.ptr`, `vm.ptr`, and `value.ptr` give the underlying pointers. `JSValue`s are 16-byte cells (`value.cell`), so C functions that take or return `JSValue` by value are wrapped as `qjs_bun_*` functions that read and write cells by pointer. Raw text parsers (`qjs_bun_eval`, `qjs_bun_parse_json`, `qjs_bun_compile_module`) require the byte after the given length to be `0`, as QuickJS does.

## Performance

TinyCC compiles QuickJS without optimizations. For production, build the same sources once with your C compiler and point `QUICKJS_BUN_NATIVE_LIBRARY` at the result:

```bash
bun run build   # writes build/quickjs-bun.<dylib|so>
QUICKJS_BUN_NATIVE_LIBRARY=$PWD/build/quickjs-bun.dylib bun start
```

The equivalent command line is in `package.json`; any C11 compiler works (`cc`, `clang`, `gcc`, `zig cc`), including cross compilation for Linux glibc, musl, and Windows. `new QuickJS({ path })` loads a specific file.

Guest code runs on the calling thread, so every call blocks the event loop for as long as it runs, up to its `timeoutMs`. A server that must keep serving while sandboxes run should give each runtime its own `Worker`.

`bun scripts/stress.ts` on a 10-core Apple Silicon machine with Bun 1.4.3 (the machine was not idle, so treat these as a floor):

| Measurement                                | TinyCC | `bun run build` |
| ------------------------------------------ | -----: | --------------: |
| idle context heap                          | 67 KiB |          67 KiB |
| evaluations per second, one VM             | 14,700 |          93,000 |
| evaluations per second, 256 VMs, 1 thread  | 20,100 |         120,500 |
| evaluations per second, 256 VMs, 4 workers | 50,300 |         234,200 |

Per-operation costs with the optimized build: creating a runtime with a context takes about 40 µs, a guest function call from the host about 90 ns, reading a property 55 ns, a host function round trip 0.35 µs, converting a small object either way about 1 µs, and `evalCode("1 + 2")` about 1 µs.

## Vendored QuickJS

`quickjs/` holds the engine sources from [bellard/quickjs](https://github.com/bellard/quickjs) at commit `9d01a96` (release `2026-06-04` plus upstream fixes). The `quickjs-libc` runtime and the experimental `intl/` and `temporal/` sources (`CONFIG_TEMPORAL_INTL`, about 70,000 lines that landed on 2026-10-10) are left out, so the engine behaves as if that option were off. Four local changes are applied on top; search `quickjs/quickjs.c` for `JS_DupValue(ctx, error_obj)` (`build_backtrace` keeps the error alive while it runs, fixing a use-after-free under memory pressure), `!defined(__TINYC__)` (Atomics are skipped under TinyCC, which has no `stdatomic.h`; optimized builds compile them and the bindings delete the global), `malloc_limit = (size_t)-1` (`JS_ThrowOutOfMemory` can always allocate its error), and `JSDefMallocHeader` (the default allocator records block sizes itself instead of calling `malloc_usable_size`, which crashes under TinyCC on Linux because Bun's bundled allocator and libc disagree, and makes memory accounting identical on every platform). To upgrade, copy the files listed under `files` in `package.json` from the new upstream commit, reapply those changes, update `quickjs/VERSION` if upstream did, and run `bun test` plus `bun run build && QUICKJS_BUN_NATIVE_LIBRARY=$PWD/build/quickjs-bun.* bun test`.

## Gotchas

- No `std` or `os` modules, no `Atomics`, and no `Intl` or `Temporal`: the guest has nothing but the language until you hand it host functions.
- Values never cross contexts. Passing a `JSValue` from one `JSContext` to another throws.
- A `JSException` owns its guest value; dispose it when you are done, or read `.name`, `.message`, and `.stack`, which are copied eagerly.
- `TimeoutError` is raised when the deadline of the call you made expires. Code interrupted inside an async function surfaces as a rejected promise whose reason is `InternalError: interrupted`.
- Close the `QuickJS` library only after every runtime is disposed.
- Disposing a context releases its heap at the next `runtime.runGC()` or when the runtime is disposed, because the global object sits in a reference cycle. A runtime that outlives many contexts should run the GC after disposing each one.
- Lone surrogates survive both directions (`newString`, `newValue`, `toString`, `keys`, atoms); source text, JSON text, and C strings handed to QuickJS by name (filenames, module and symbol names) must be well-formed.

## Examples

- `examples/sandbox`: a 60-line event loop with `console.log` and `sleep` host functions. `bun examples/sandbox/index.ts 'await sleep(10); 6 * 7'`.
- `examples/codemode-chat`: an interactive chat where the model writes JavaScript against a persistent QuickJS REPL with async host tools, built on [pi durable](https://github.com/earendil-works/pi/tree/main/packages/durable). Uses Anthropic when `ANTHROPIC_API_KEY` is set and Amazon Bedrock otherwise. `bun examples/codemode-chat/index.ts` for a REPL, or pass a prompt as the argument for a single turn.

## License

[MIT](LICENSE)
