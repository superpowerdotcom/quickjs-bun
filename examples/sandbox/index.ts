import {
  JSException,
  JSRuntime,
  QuickJS,
  QuickJSEvalFlags,
  QuickJSPromiseState,
} from "../../index";

const code =
  process.argv[2] ??
  `
const events = [];
Promise.resolve().then(() => events.push("microtask"));
await sleep(10);
events.push("host timer");
console.log("inside QuickJS:", events.join(" -> "));
({ events, answer: 6 * 7 });
`;

using library = new QuickJS();
using runtime = new JSRuntime({ library, memoryBytes: 32 * 1024 * 1024 });
using vm = runtime.createContext({ timeoutMs: 250 });
const timers = new Set<Promise<void>>();

using consoleObject = vm.newObject();
using log = vm.newFunction((...args) => console.log(...args.map((arg) => vm.dump(arg))));
consoleObject.setProp("log", log);
vm.setGlobal("console", consoleObject);
using sleep = vm.newFunction((ms) => {
  const deferred = vm.newPromise();
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      deferred.resolve(vm.undefined);
      deferred.dispose();
      timers.delete(timer);
      resolve();
    }, ms.toNumber()),
  );
  timers.add(timer);
  return deferred.promise.dup();
});
vm.setGlobal("sleep", sleep);

const deadline = Date.now() + 5_000;
try {
  using result = vm.evalCode(code, {
    filename: "<sandbox>",
    flags: QuickJSEvalFlags.TYPE_GLOBAL | QuickJSEvalFlags.ASYNC,
  });
  while (result.promiseState === QuickJSPromiseState.PENDING) {
    if (runtime.executePendingJob()) continue;
    if (timers.size === 0) throw new Error("the script is waiting on nothing");
    if (Date.now() > deadline) throw new Error("the script took longer than 5s");
    await Promise.race(timers);
  }
  using settled = result.promiseResult();
  if (result.promiseState === QuickJSPromiseState.REJECTED) throw new JSException(settled.dup());
  console.log("result:", (vm.dump(settled) as { value: unknown }).value);
  console.log("memory used:", runtime.memoryUsedBytes(), "bytes");
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
}
