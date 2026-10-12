import { cpus } from "node:os";
import { JSRuntime, QuickJS, type JSContext } from "../index";

const maxVms = Number(process.env.STRESS_VMS ?? 256);
const iterations = Number(process.env.STRESS_ITERATIONS ?? 250);
const workers = Number(process.env.STRESS_WORKERS ?? Math.min(4, cpus().length));
const code = "var total = 0; for (var i = 0; i < 100; i++) total += i; total;";

function run(vm: JSContext): void {
  using result = vm.evalCode(code);
  if (result.toNumber() !== 4950) throw new Error("wrong result");
}

function sweep(library: QuickJS, count: number) {
  const vms = Array.from({ length: count }, () =>
    new JSRuntime({ library, memoryBytes: 64 * 1024 * 1024 }).createContext(),
  );
  for (const vm of vms) run(vm);
  const started = performance.now();
  for (const vm of vms) for (let i = 0; i < iterations; i++) run(vm);
  const wallMs = performance.now() - started;
  const heap = vms.reduce((sum, vm) => sum + vm.runtime.memoryUsedBytes(), 0n);
  for (const vm of vms) vm.runtime.dispose();
  return { evals: count * iterations, wallMs, heap, rss: process.memoryUsage().rss };
}

if (process.argv[2] === "--worker") {
  using library = new QuickJS();
  const result = sweep(library, Math.ceil(maxVms / workers));
  console.log(JSON.stringify({ evals: result.evals, wallMs: result.wallMs, rss: result.rss }));
  process.exit(0);
}

using library = new QuickJS();
console.log(
  `quickjs-bun stress (${process.platform}/${process.arch}, Bun ${Bun.version}, ${cpus().length} CPUs, ${process.env.QUICKJS_BUN_NATIVE_LIBRARY ? "prebuilt" : "tinycc"} build)`,
);
Bun.gc(true);
const baseline = process.memoryUsage().rss;

const started = performance.now();
const single = new JSRuntime({ library }).createContext();
console.log(`create one VM:        ${(performance.now() - started).toFixed(2)} ms`);
console.log(
  `idle VM heap:         ${(Number(single.runtime.memoryUsedBytes()) / 1024).toFixed(1)} KiB`,
);
const one = sweep(library, 1);
console.log(`one VM:               ${((one.evals / one.wallMs) * 1000).toFixed(0)} evals/s`);
single.runtime.dispose();

const many = sweep(library, maxVms);
console.log(
  `${maxVms} VMs, one thread: ${((many.evals / many.wallMs) * 1000).toFixed(0)} evals/s, ` +
    `${(Number(many.heap) / 1024 / 1024).toFixed(1)} MiB QuickJS heap, ` +
    `${((many.rss - baseline) / 1024 / 1024).toFixed(1)} MiB RSS growth`,
);

const parallelStarted = performance.now();
const reports = await Promise.all(
  Array.from({ length: workers }, async () => {
    const proc = Bun.spawn([process.execPath, import.meta.path, "--worker"], {
      env: process.env,
      stdout: "pipe",
      stderr: "inherit",
    });
    return JSON.parse(await new Response(proc.stdout).text()) as { evals: number };
  }),
);
const parallelMs = performance.now() - parallelStarted;
const parallelEvals = reports.reduce((sum, report) => sum + report.evals, 0);
console.log(
  `${maxVms} VMs, ${workers} processes: ${((parallelEvals / parallelMs) * 1000).toFixed(0)} evals/s`,
);
