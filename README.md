# quickjs-bun

Lightweight, fully-featured, idiomatic [bun:ffi](https://bun.sh/docs/api/ffi) bindings to [QuickJS](https://bellard.org/quickjs/).

[QuickJS](https://bellard.org/quickjs/) is a small, fast, and embeddable JavaScript interpreter created by [Fabrice Bellard](https://en.wikipedia.org/wiki/Fabrice_Bellard). It features a small footprint (just 210 KiB of x86 code for a simple "hello world" program), capabilities to construct strict sandboxes (e.g. memory limits, execution timeouts), and nearly complete ES2023 support (including modules, asynchronous generators, and proxies) without any external dependencies.

## Rationale

Running untrusted JavaScript code in a secure, isolated environment is a common requirement for many applications (e.g. plugin systems, user-defined functions, server-side rendering).

However, integrating an embedded JavaScript interpreter into a Node.js or Bun application typically introduces significant overhead and complexity:

- **Node-API (napi) overhead:** Most bindings use Node-API, which requires allocating intermediate wrapper objects and crossing the JS-to-C++ boundary, introducing latency for high-frequency calls.
- **Memory leaks:** Managing the lifecycle of C pointers (like `JSContext` or `JSValue`) from a garbage-collected language like JavaScript is error-prone, often leading to memory leaks or use-after-free segfaults.
- **Lack of true isolation:** Many existing sandboxes run within the same V8/JavaScriptCore isolate, meaning a runaway `while(true)` loop or a massive array allocation can crash or hang the host process.

`quickjs-bun` solves this by directly mapping QuickJS's C API to Bun using `bun:ffi`.

`bun:ffi` embeds [tcc](https://bellard.org/tcc/) (TinyCC) to JIT-compile C bindings on the fly, making cross-language calls roughly 2-6x faster than Node-API. Pointers are represented natively as 53-bit JavaScript `number`s, allowing for zero-copy memory access and reduced overhead.

## Features

- **FFI:** Built entirely on [bun:ffi](https://bun.sh/docs/api/ffi).
- **Resource Limits:** Enforce execution timeouts (via `JS_SetInterruptHandler`), memory limits (`JS_SetMemoryLimit`), and stack limits (`JS_SetMaxStackSize`).
- **Host Functions:** Expose Bun/TypeScript functions to the QuickJS interpreter using `bun:ffi`'s [`JSCallback`](https://bun.sh/docs/api/ffi#callbacks).
- **ES Modules:** Full support for ES modules with a custom module loader hooking into `JS_SetModuleLoaderFunc`.
- **Async & Promises:** Support for asynchronous host promises and microtask queues via `JS_ExecutePendingJob`.
- **Resource Management:** QuickJS uses deterministic reference counting (`JS_DupValue` / `JS_FreeValue`). `quickjs-bun` supports TypeScript's [Explicit Resource Management](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html#using-declarations-and-explicit-resource-management) (`using` keyword / `Symbol.dispose`) to automatically free C pointers when they go out of scope. For longer-lived references, `.dispose()` must be called manually.

## Production Readiness

Tested against Bun `>=1.3.14`.

It supports macOS and Linux across both `x86_64` and `aarch64` architectures natively. The underlying C bridge (`quickjs_bridge.c` and `alloca.S`) is written to maintain compatibility with Bun's embedded TinyCC compiler, allowing `quickjs-bun` to compile the QuickJS interpreter on-the-fly without requiring any build tools on the host machine.

### Windows Support

Windows is supported, but requires a manually built dynamic library (`.dll`).

While Bun embeds TinyCC, automatically locating the correct system include directories and headers necessary to compile C code on Windows is currently unreliable. Because `quickjs-bun` relies on TinyCC to compile the QuickJS source code on-the-fly, this automatic compilation fails on Windows.

To use `quickjs-bun` on Windows, you must compile QuickJS into a dynamic library yourself (using MSVC, GCC, or Clang) and pass the path to the compiled `.dll` when initializing the library:

```typescript
import { QuickJS } from "quickjs-bun";

// On Windows, you MUST pass the path to a manually compiled library
using library = new QuickJS({ path: "path/to/quickjs.dll" });
```

You can also use the `QUICKJS_BUN_NATIVE_LIBRARY` environment variable to specify the path to the dynamic library:

```bash
export QUICKJS_BUN_NATIVE_LIBRARY="path/to/quickjs.dll"
```

## Benchmarks

The benchmark suite (`scripts/stress.ts`) measures the overhead of instantiating and executing code across multiple QuickJS interpreters. This provides a baseline for capacity planning in multi-tenant environments—such as spawning an isolated interpreter per incoming task.

On a 10-core `darwin/arm64` machine, spawning a new VM takes ~1.2ms. Each idle VM consumes ~70 KiB of QuickJS heap memory. A single thread handles ~40,000 evaluations per second across 256 active VMs. Distributing 256 VMs across 4 parallel Bun workers yields ~105,000 evaluations per second.

```bash
% bun scripts/stress.ts
quickjs-bun stress (darwin/arm64, Bun 1.3.14, 10 CPUs)
options: maxVms=256 step=32 iterations=250 memoryBytes=67108864 parallelWorkers=4 parallelVmsPerWorker=64

single VM
  createMs=1.21
  rssDelta=4.02 MiB
  quickjsHeap=69.73 KiB
  evalsPerSecond=37734
  cpuMicrosPerEval=38.9

live VM growth
  vms=1 rssDelta=4.53 MiB quickjsHeap=69.73 KiB
  vms=32 rssDelta=10.41 MiB quickjsHeap=2.18 MiB
  vms=64 rssDelta=19.19 MiB quickjsHeap=4.36 MiB
  vms=96 rssDelta=27.16 MiB quickjsHeap=6.54 MiB
  vms=128 rssDelta=35.97 MiB quickjsHeap=8.72 MiB
  vms=160 rssDelta=44.72 MiB quickjsHeap=10.90 MiB
  vms=192 rssDelta=53.56 MiB quickjsHeap=13.07 MiB
  vms=224 rssDelta=64.08 MiB quickjsHeap=15.25 MiB
  vms=256 rssDelta=72.70 MiB quickjsHeap=17.43 MiB

active VM eval sweep
  vms=256
  totalEvals=64000
  wallMs=1579.35
  cpuMs=1597.08
  evalsPerSecond=40523
  rssDelta=127.97 MiB

parallel process eval
  workers=4
  totalVms=256
  totalEvals=64000
  wallMs=605.96
  cpuMs=1832.81
  evalsPerSecond=105618
  rssDelta=167.59 MiB
  quickjsHeap=17.43 MiB
```

## Installation

```bash
bun add quickjs-bun
```

## Usage

### Basic Example

Runtimes and contexts can be managed using the `using` keyword to ensure `JS_FreeContext` and `JS_FreeRuntime` are automatically called when the scope exits.

```typescript
import { QuickJS, JSRuntime } from "quickjs-bun";

// Initialize the QuickJS library
using library = new QuickJS();

// Create a new runtime and context
using runtime = new JSRuntime({ library });
using context = runtime.createContext();

// Evaluate some JavaScript code
using result = context.evalCode("1 + 2");
console.log("Result:", result.toNumber()); // Output: 3
```

You can also compile code to bytecode and evaluate it later to save parsing overhead:

```typescript
using bytecode = context.compileCode("40 + 2");
using result = context.evalFunction(bytecode);
console.log(result.toNumber()); // Output: 42
```

### Resource Limits

You can enforce limits on memory, stack size, and execution time to safely run untrusted code. Timeouts are implemented using QuickJS's interrupt handlers under the hood, ensuring the host process is never blocked.

```typescript
import { QuickJS, JSRuntime } from "quickjs-bun";

using library = new QuickJS();

// Restrict memory usage to 1MB and stack size to 64KB
using runtime = new JSRuntime({
  library,
  memoryBytes: 1024 * 1024,
  stackBytes: 64 * 1024,
});

// Restrict execution time to 25ms
using context = runtime.createContext({ timeoutMs: 25 });

try {
  // This will throw a JSException because of the timeout limit
  context.evalCode("while (true) {}");
} catch (e) {
  console.error("Execution failed:", e.message); // Output: QuickJS execution timed out
}

try {
  // This will throw a JSException because of the memory limit
  context.evalCode("const items = []; while (true) items.push(new Array(1000).fill('x').join(''))");
} catch (e) {
  console.error("Execution failed:", e.message); // Output: out of memory
}
```

### Data Conversion

You can easily convert standard JavaScript values (primitives, plain objects, arrays) between Bun and QuickJS using `context.newValue()` and `context.dump()`.

```typescript
import { QuickJS, JSRuntime } from "quickjs-bun";

using library = new QuickJS();
using runtime = new JSRuntime({ library });
using context = runtime.createContext();

// Convert a Bun value into a QuickJS JSValue
using user = context.newValue({
  name: "Alice",
  scores: [10, 20, 30],
});

// Expose it to the QuickJS global scope
context.setGlobal("user", user);

// Evaluate code that uses the object
using result = context.evalCode("user.scores.reduce((a, b) => a + b, 0)");

// Convert the QuickJS JSValue back into a Bun value
const hostResult = context.dump(result);
console.log(hostResult); // Output: 60
```

For JSON, you can use `context.parseJson` and `context.jsonStringify`:

```typescript
using parsed = context.parseJson('{"answer":42}');
using jsonText = context.jsonStringify(parsed);
console.log(jsonText.toString()); // '{"answer":42}'
```

### Exposing Host Functions

You can expose functions written in Bun to the QuickJS interpreter. These are mapped to C function pointers using `bun:ffi`'s `JSCallback`.

```typescript
import { QuickJS, JSRuntime } from "quickjs-bun";

using library = new QuickJS();
using runtime = new JSRuntime({ library });
using context = runtime.createContext();

// Create a host function. The 'using' keyword ensures the JSCallback is closed
// and the underlying C function pointer is freed.
using add = context.newFunction((left, right) => {
  return context.newNumber(left.toNumber() + right.toNumber());
});

// Expose it to the global object in QuickJS
context.setGlobal("add", add);

// Call the host function from QuickJS
using result = context.evalCode("add(20, 22)");
console.log("Result:", result.toNumber()); // Output: 42
```

### Modules

You can define a custom module loader to resolve and load ES modules. This hooks into QuickJS's `JS_SetModuleLoaderFunc`.

```typescript
import { QuickJS, JSRuntime, QuickJSEvalFlags } from "quickjs-bun";

using library = new QuickJS();
using runtime = new JSRuntime({ library });

// Define a custom module loader
runtime.setModuleLoader((name) => {
  if (name === "/app/math.js") {
    return "export const answer = 42;";
  }
  throw new Error(`Module not found: ${name}`);
});

using context = runtime.createContext();

// Evaluate a module
context.evalCode('import { answer } from "/app/math.js"; globalThis.result = answer;', {
  filename: "/app/main.js",
  flags: QuickJSEvalFlags.TYPE_MODULE,
});

using result = context.getGlobal("result");
console.log("Result:", result.toNumber()); // Output: 42
```

You can also define native C modules directly from Bun using `context.newCModule`:

```typescript
// Define a native module named "host:math"
const module = context.newCModule("host:math", (mod) => {
  mod.setExports({ answer: 42 });
});
module.addExports(["answer"]);

// Register it with the module loader
runtime.setModuleLoader((name) => {
  if (name === "host:math") return module;
});

// Import and use it
context.evalCode('import { answer } from "host:math"; globalThis.result = answer;', {
  flags: QuickJSEvalFlags.TYPE_MODULE,
});
```

### Async and Promises

`quickjs-bun` supports asynchronous host promises and executing pending jobs via `JS_ExecutePendingJob`.

```typescript
import { QuickJS, JSRuntime, QuickJSPromiseState } from "quickjs-bun";

using library = new QuickJS();
using runtime = new JSRuntime({ library });
using context = runtime.createContext();

// Create a deferred promise in QuickJS
using deferred = context.newPromise();
context.setGlobal("pending", deferred.promise);

// Chain a continuation
using continuation = context.evalCode("pending.then(value => value + 1)");

// Resolve the promise from Bun
using value = context.newNumber(41);
deferred.resolve(value);

// Execute pending jobs in the QuickJS microtask queue
runtime.executePendingJobs();

// Get the result
if (continuation.promiseState === QuickJSPromiseState.FULFILLED) {
  using result = continuation.promiseResult();
  console.log("Result:", result.toNumber()); // Output: 42
}
```

### Memory Usage & Debugging

`quickjs-bun` provides tools to inspect the memory footprint of your sandboxes and catch unhandled promise rejections.

```typescript
import { QuickJS, JSRuntime } from "quickjs-bun";

using library = new QuickJS();
using runtime = new JSRuntime({ library });

// Track unhandled promise rejections
runtime.setPromiseRejectionTracker(({ context, isHandled, reason }) => {
  if (!isHandled) {
    console.error("Unhandled rejection in QuickJS:", context.dump(reason));
  }
});

using context = runtime.createContext();
context.evalCode("Promise.reject('boom')");
runtime.executePendingJobs(); // Triggers the rejection tracker

// Inspect memory usage
const usage = runtime.memoryUsage();
console.log(`Memory used: ${usage.memoryUsedSize} bytes`);

// Dump detailed memory statistics
console.log(runtime.dumpMemoryUsage());
```

### Binary Serialization

QuickJS has a built-in binary serialization format that is much faster and more space-efficient than JSON. You can serialize and deserialize objects directly:

```typescript
import { QuickJS, JSRuntime, QuickJSWriteObjectFlags, QuickJSReadObjectFlags } from "quickjs-bun";

using library = new QuickJS();
using runtime = new JSRuntime({ library });
using context = runtime.createContext();

using original = context.newValue({ answer: 42 });

// Serialize to a Uint8Array
const bytes = original.writeObject(QuickJSWriteObjectFlags.REFERENCE);

// Deserialize back into a JSValue
using decoded = context.readObject(bytes, QuickJSReadObjectFlags.REFERENCE);

console.log(context.dump(decoded)); // Output: { answer: 42 }
```

### Classes & Opaque Pointers

You can bind native C/C++ or Bun objects to QuickJS objects by registering a class and attaching an opaque pointer. This is useful for exposing native handles (like file descriptors or database connections) to JavaScript.

```typescript
import { QuickJS, JSRuntime } from "quickjs-bun";
import { ptr } from "bun:ffi";

using library = new QuickJS();
using runtime = new JSRuntime({ library });
using context = runtime.createContext();

// 1. Register a new class ID
const classId = runtime.registerClass("DatabaseConnection");

// 2. Create a prototype for the class
using prototype = context.newValue({ kind: "database" });
context.setClassProto(classId, prototype);

// 3. Instantiate an object of that class
using instance = context.newObjectClass(classId);

// 4. Attach a raw pointer (e.g. a memory address) to the object
const myNativePointer = ptr(new Uint8Array(8));
instance.setOpaque(myNativePointer);

// 5. Retrieve the pointer later
const retrievedPointer = instance.getOpaque(classId);
```

### Atoms

QuickJS uses "atoms" to store object property names and strings efficiently. You can create and manage atoms directly:

```typescript
import { QuickJS, JSRuntime } from "quickjs-bun";

using library = new QuickJS();
using runtime = new JSRuntime({ library });
using context = runtime.createContext();

// Create an atom from a string or number
using atom = context.newAtom("myProperty");

// Convert an atom back to a string or JSValue
console.log(atom.toString()); // "myProperty"
using value = atom.toValue();

// Atoms are automatically freed when they go out of scope via `using`
```

### Escape Hatches

If `quickjs-bun` does not expose a specific QuickJS feature you need, you can bypass the high-level wrappers and interact directly with the raw C API.

The `QuickJS` instance exposes all loaded C functions via the `.native` property. Furthermore, `JSRuntime`, `JSContext`, and `JSValue` all expose their underlying C pointers via the `.ptr` property.

This allows you to call any QuickJS function directly using `bun:ffi`:

```typescript
import { QuickJS, JSRuntime } from "quickjs-bun";

using library = new QuickJS();
using runtime = new JSRuntime({ library });
using context = runtime.createContext();

// Use high-level API to create a value
using text = context.newString("hello");

// Use raw FFI escape hatch to call JS_ValueToAtom directly
const atom = library.native.qjs_bun_value_to_atom(context.ptr, text.ptr);

// Free the atom using the raw C API
library.native.JS_FreeAtom(context.ptr, atom);
```

## Gotchas & Limitations

- **No standard library or OS modules:** By default, QuickJS includes `std` and `os` modules. `quickjs-bun` explicitly disables these. You must manually expose any required host functionality.
- **Value Lifetimes:** QuickJS uses reference counting. If you do not use the `using` keyword for `JSValue`s, `JSContext`s, or `JSRuntime`s, you will leak memory. Always use `using` or manually call `.dispose()`.
- **Cross-VM Values:** You cannot pass a `JSValue` created in one `JSContext` to another `JSContext`. QuickJS runtimes are strictly isolated. Attempting to do so will throw an error.
- **Host Promises:** If you expose an asynchronous Bun function to QuickJS, you must manually drive the QuickJS event loop by calling `runtime.executePendingJobs()` so that microtasks (like `.then()` continuations) can resolve. See the `examples/sandbox` directory for an event loop implementation.

## Examples

`quickjs-bun` includes two examples demonstrating usage.

### 1. The Sandbox Event Loop (`examples/sandbox`)

QuickJS does not come with a built-in event loop for host timers (like `setTimeout`) or asynchronous host I/O. If you want to use `await` or Promises inside QuickJS that depend on host operations, you must manually drive the microtask queue.

The `examples/sandbox` directory demonstrates how to build a secure event loop bridging Bun and QuickJS. It shows how to:

- Inject global functions like `console.log` and a custom `sleep(ms)` into the sandbox.
- Safely track and manage host tasks (like `setTimeout`) using `bun:ffi`'s `JSCallback`.
- Manually drive the QuickJS microtask queue using `runtime.executePendingJobs()` until all promises are settled.
- Enforce strict timeouts on both QuickJS execution and asynchronous host operations, ensuring the sandbox can never hang the main thread.

You can run the sandbox with an optional inline script:

```bash
# Run the default sample code
bun examples/sandbox/index.ts

# Run a custom script
bun examples/sandbox/index.ts 'console.log("Hello from QuickJS!"); await sleep(100);'
```

### 2. Codemode Chat (`examples/codemode-chat`)

**Codemode** is a paradigm where Large Language Models (LLMs) write and execute code to orchestrate tools, rather than relying on standard JSON tool calls. LLMs are naturally better at writing code (with loops, conditionals, and error handling) than they are at predicting complex sequences of rigid tool calls.

The `examples/codemode-chat` directory implements a Codemode REPL using `quickjs-bun` and Claude 4.6 Opus (via AWS Bedrock). It demonstrates how to:

- Provide an LLM with a persistent QuickJS REPL (`quickjs_repl` tool) supporting top-level `await`.
- Inject typed, asynchronous host tools (e.g., an in-memory `notes` database, or network-backed `weather` and `wiki` tools) directly into the QuickJS global scope.
- Catch and return execution results (or errors) back to the LLM, allowing it to self-correct its code.
- Completely isolate the LLM's generated code from the host system (no filesystem, no arbitrary network access, strict timeouts, and strict memory limits).

You can run the interactive Codemode chat yourself:

```bash
# Start the interactive chat REPL
bun examples/codemode-chat/index.ts

# Run a deterministic local demo without hitting AWS Bedrock
bun examples/codemode-chat/index.ts --demo

# Run a single snippet through the sandbox directly
bun examples/codemode-chat/index.ts --code 'await notes.list()'
```

#### Environment Variables

- `AWS_ACCESS_KEY_ID`: Your AWS access key ID.
- `AWS_SECRET_ACCESS_KEY`: Your AWS secret access key.
- `AWS_REGION` or `AWS_DEFAULT_REGION`: The AWS region to use for Bedrock (defaults to `us-east-1`).
- `BEDROCK_MODEL_ID`: The model ID to use (defaults to `us.anthropic.claude-opus-4-6-v1`).

#### CLI Flags

- `--code <js>`: Run one snippet in the QuickJS sandbox.
- `--demo`: Run a deterministic local demo.
- `--network-tools`: Install weather and wiki host tools for `--code`.
- `--eval-timeout-ms <n>`: QuickJS execution timeout. Default: 2000.
- `--max-host-calls <n>`: Maximum host tool calls per snippet. Default: 256.
- `--max-microtasks <n>`: Maximum microtasks per snippet. Default: 10000.
- `--max-tool-rounds <n>`: Maximum Bedrock tool rounds in chat mode. Default: 8.
- `--tool-timeout-ms <n>`: Per-tool host timeout. Default: 8000.

## License

[MIT](LICENSE)
