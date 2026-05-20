import assert from "node:assert/strict";
import {
  QuickJS,
  JSException,
  QuickJSEvalFlags,
  QuickJSPromiseState,
  JSRuntime,
  type Deferred,
  type HostValue,
  type JSContext,
  type JSValue,
} from "../../index";

interface EventLoopOptions {
  evalTimeoutMs?: number;
  hostCallTimeoutMs?: number;
  maxHostCalls?: number;
  maxJobs?: number;
}
type ResolvedEventLoopOptions = Required<EventLoopOptions>;
interface HostTask {
  cancel: () => void;
  deferred: Deferred;
  settle: () => void;
  settled: Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
}
type HostPromiseStart = (
  resolve: (value?: HostValue) => void,
  reject: (error: unknown) => void,
) => () => void;

const DEFAULT_OPTIONS: ResolvedEventLoopOptions = {
  evalTimeoutMs: 1_000,
  hostCallTimeoutMs: 250,
  maxHostCalls: 64,
  maxJobs: 10_000,
};
const SAMPLE_CODE = `
const events = [];

Promise.resolve().then(() => events.push("microtask"));
await sleep(10);
events.push("host timer");

console.log("inside QuickJS:", events.join(" -> "));
({ events, answer: 6 * 7 });
`.trim();

class QuickJSEventLoop {
  readonly options: ResolvedEventLoopOptions;

  #disposed = false;
  #remainingHostCalls: number | undefined;
  #tasks = new Set<HostTask>();

  constructor(
    readonly vm: JSContext,
    options: EventLoopOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    assertPositiveNumber(this.options.evalTimeoutMs, "evalTimeoutMs");
    assertPositiveNumber(this.options.hostCallTimeoutMs, "hostCallTimeoutMs");
    assertPositiveInteger(this.options.maxHostCalls, "maxHostCalls");
    assertPositiveInteger(this.options.maxJobs, "maxJobs");
    this.#installGlobals();
  }

  async run(code: string): Promise<unknown> {
    assert(!this.#disposed, "QuickJS event loop is disposed");
    assert(this.#remainingHostCalls === undefined, "QuickJS event loop is already running");
    assert(code.trim().length > 0, "Code is empty");

    this.#remainingHostCalls = this.options.maxHostCalls;
    try {
      using result = this.vm.evalCode(code, {
        filename: "<sandbox>",
        flags: QuickJSEvalFlags.TYPE_GLOBAL | QuickJSEvalFlags.ASYNC,
        timeoutMs: this.options.evalTimeoutMs,
      });
      using value = await this.#runUntilSettled(result);
      return unwrapAsyncValue(this.vm.dump(value));
    } catch (error) {
      if (error instanceof JSException) {
        const message = `${error.name}: ${error.message}`;
        error.dispose();
        throw new Error(message);
      }
      throw error;
    } finally {
      this.#remainingHostCalls = undefined;
      this.#abortHostTasks();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortHostTasks();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  async #runUntilSettled(result: JSValue): Promise<JSValue> {
    if (result.promiseState === QuickJSPromiseState.NOT_PROMISE) return result.dup();

    const deadlineMs = performance.now() + this.options.evalTimeoutMs;
    let jobs = 0;

    for (;;) {
      switch (result.promiseState) {
        case QuickJSPromiseState.FULFILLED:
          return result.promiseResult();
        case QuickJSPromiseState.REJECTED:
          throw new JSException(result.promiseResult());
      }

      const remainingMs = deadlineMs - performance.now();
      if (remainingMs <= 0)
        throw new Error(`QuickJS event loop timed out after ${this.options.evalTimeoutMs}ms`);

      if (this.vm.runtime.executePendingJob(Math.max(1, remainingMs))) {
        jobs++;
        if (jobs > this.options.maxJobs) {
          throw new Error(`QuickJS event loop exceeded ${this.options.maxJobs} jobs`);
        }
        continue;
      }

      const tasks = [...this.#tasks];
      if (tasks.length === 0) {
        throw new Error("QuickJS promise is pending with no host tasks or jobs");
      }
      await waitForHostTask(tasks, remainingMs);
    }
  }

  #installGlobals(): void {
    using consoleObject = this.vm.newObject();
    using log = this.vm.newFunction((...args) => {
      console.log(...args.map((arg) => formatValue(unwrapAsyncValue(this.vm.dump(arg)))));
    });
    consoleObject.setProp("log", log);
    this.vm.setGlobal("console", consoleObject);

    using sleep = this.vm.newFunction((ms) => this.#sleep(ms));
    this.vm.setGlobal("sleep", sleep);
  }

  #sleep(ms: JSValue | undefined): JSValue {
    this.#takeHostCall("sleep");

    const value = ms === undefined ? 0 : this.vm.dump(ms);
    assert(typeof value === "number" && Number.isFinite(value), "sleep(ms) expects a number");
    assert(value >= 0, "sleep(ms) expects a non-negative duration");
    assert(
      value <= this.options.hostCallTimeoutMs,
      `sleep(ms) cannot exceed ${this.options.hostCallTimeoutMs}ms`,
    );

    return this.#hostPromise("sleep", (resolve) => {
      const timeout = setTimeout(() => resolve(undefined), value);
      return () => clearTimeout(timeout);
    });
  }

  #takeHostCall(name: string): void {
    assert(
      this.#remainingHostCalls !== undefined,
      `${name}() was called outside an active QuickJS execution`,
    );
    if (this.#remainingHostCalls === 0) {
      throw new Error(`Exceeded ${this.options.maxHostCalls} host calls`);
    }
    this.#remainingHostCalls--;
  }

  #hostPromise(name: string, start: HostPromiseStart): JSValue {
    const deferred = this.vm.newPromise();
    const promise = deferred.promise.dup();
    let done = false;
    let settleTask!: () => void;

    const task: HostTask = {
      cancel: () => {},
      deferred,
      settle: () => settleTask(),
      settled: new Promise<void>((resolve) => {
        settleTask = resolve;
      }),
      timeout: setTimeout(() => {
        reject(new Error(`${name} timed out after ${this.options.hostCallTimeoutMs}ms`));
      }, this.options.hostCallTimeoutMs),
    };

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(task.timeout);
      task.cancel();
      this.#tasks.delete(task);
      deferred.dispose();
      task.settle();
    };
    const resolve = (value?: HostValue) => {
      if (done) return;
      try {
        using handle = this.vm.newValue(value);
        deferred.resolve(handle);
      } finally {
        finish();
      }
    };
    const reject = (error: unknown) => {
      if (done) return;
      try {
        using handle = this.vm.newError(error instanceof Error ? error : new Error(String(error)));
        deferred.reject(handle);
      } finally {
        finish();
      }
    };

    this.#tasks.add(task);
    try {
      task.cancel = start(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return promise;
  }

  #abortHostTasks(): void {
    for (const task of this.#tasks) {
      clearTimeout(task.timeout);
      task.cancel();
      task.deferred.dispose();
      task.settle();
    }
    this.#tasks.clear();
  }
}

async function main(): Promise<void> {
  using quickjs = new QuickJS();
  using runtime = new JSRuntime({
    library: quickjs,
    memoryBytes: 32 * 1024 * 1024,
    runtimeInfo: "quickjs-bun sandbox example",
    stackBytes: 512 * 1024,
  });
  runtime.setPromiseRejectionTracker(({ context, isHandled, reason }) => {
    if (isHandled) return;
    console.error("Unhandled QuickJS rejection:", formatValue(context.dump(reason)));
  });

  using vm = runtime.createContext({
    timeoutMs: DEFAULT_OPTIONS.evalTimeoutMs,
  });
  using eventLoop = new QuickJSEventLoop(vm);
  const code = process.argv.slice(2).join(" ").trim() || SAMPLE_CODE;
  const result = await eventLoop.run(code);

  runtime.runGC();
  console.log("result:", formatValue(result));
  console.log("memory used:", `${runtime.memoryUsedBytes()} bytes`);
}

async function waitForHostTask(tasks: readonly HostTask[], timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.race(tasks.map((task) => task.settled)),
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for host task")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function unwrapAsyncValue(value: unknown): unknown {
  return isRecord(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "value")
    ? value.value
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return Bun.inspect(value, { colors: false, depth: 10 });
}

function assertPositiveInteger(value: number, name: string): void {
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
}

function assertPositiveNumber(value: number, name: string): void {
  assert(Number.isFinite(value) && value > 0, `${name} must be a positive number`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
