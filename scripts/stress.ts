import assert from "node:assert/strict";
import os from "node:os";
import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { QuickJS, JSRuntime, type JSContext } from "../index";

interface Args {
  json: boolean;
  maxVms: number;
  parallelWorkers: number;
  parallelVmsPerWorker: number;
  step: number;
  iterations: number;
  memoryBytes: number;
}

interface Cpu {
  user: number;
  system: number;
}
interface Sample {
  vms: number;
  rssBytes: number;
  rssDeltaBytes: number;
  quickjsHeapBytes: string;
}

interface Report {
  runtime: {
    bun: string;
    platform: string;
    arch: string;
    cpus: number;
  };
  options: Omit<Args, "json">;
  singleVm: {
    createMs: number;
    rssDeltaBytes: number;
    quickjsHeapBytes: string;
    evalsPerSecond: number;
    cpuMicrosPerEval: number;
  };
  liveVmGrowth: Sample[];
  activeVmEval: {
    vms: number;
    iterationsPerVm: number;
    totalEvals: number;
    wallMs: number;
    cpuMs: Cpu;
    evalsPerSecond: number;
    rssDeltaBytes: number;
  };
  parallelProcessEval: {
    workers: number;
    vmsPerWorker: number;
    totalVms: number;
    iterationsPerVm: number;
    totalEvals: number;
    wallMs: number;
    cpuMs: Cpu;
    evalsPerSecond: number;
    rssDeltaBytes: number;
    quickjsHeapBytes: string;
  };
}

const code = `
var total = 0;
for (var i = 0; i < 100; i++) total += i;
total;
`;

function parseArgs(): Args {
  const cpus = os.cpus().length;
  const { values } = parseNodeArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    options: {
      json: { type: "boolean", default: false },
      "max-vms": { type: "string", default: "256" },
      "parallel-workers": {
        type: "string",
        default: String(Math.max(1, Math.min(4, cpus))),
      },
      "parallel-vms-per-worker": { type: "string" },
      step: { type: "string", default: "32" },
      iterations: { type: "string", default: "250" },
      "memory-bytes": { type: "string", default: String(64 * 1024 * 1024) },
    },
  });
  const parsed: Args = {
    json: values.json,
    maxVms: readPositiveInteger("--max-vms", values["max-vms"]),
    parallelWorkers: readPositiveInteger("--parallel-workers", values["parallel-workers"]),
    parallelVmsPerWorker:
      values["parallel-vms-per-worker"] === undefined
        ? 0
        : readPositiveInteger("--parallel-vms-per-worker", values["parallel-vms-per-worker"]),
    step: readPositiveInteger("--step", values.step),
    iterations: readPositiveInteger("--iterations", values.iterations),
    memoryBytes: readPositiveInteger("--memory-bytes", values["memory-bytes"]),
  };

  assert(parsed.step <= parsed.maxVms, "--step must be less than or equal to --max-vms");
  if (parsed.parallelVmsPerWorker === 0) {
    parsed.parallelVmsPerWorker = Math.ceil(parsed.maxVms / parsed.parallelWorkers);
  }
  return parsed;
}

function readPositiveInteger(name: string, raw: string | undefined): number {
  assert(raw !== undefined, `${name} needs a value`);
  const value = Number(raw);
  assert(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes("--stress-worker")) {
    console.log(JSON.stringify(measureWorkerEval(parseWorkerArgs())));
    return;
  }

  const args = parseArgs();
  const report = await stress(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

async function stress(args: Args): Promise<Report> {
  using library = new QuickJS();
  collect();
  const rssStart = rss();
  const singleVm = measureSingleVm(args, library);
  collect();
  const growth = measureLiveVmGrowth(args, library, rssStart);
  const activeVmEval = measureActiveVmEval(args, library, rssStart);
  const parallelProcessEval = await measureParallelProcessEval(args);
  return {
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
    },
    options: {
      maxVms: args.maxVms,
      parallelWorkers: args.parallelWorkers,
      parallelVmsPerWorker: args.parallelVmsPerWorker,
      step: args.step,
      iterations: args.iterations,
      memoryBytes: args.memoryBytes,
    },
    singleVm,
    liveVmGrowth: growth,
    activeVmEval,
    parallelProcessEval,
  };
}

function measureSingleVm(args: Args, library: QuickJS): Report["singleVm"] {
  collect();
  const beforeRss = rss();
  const createStarted = performance.now();
  const vm = createVm(library, args.memoryBytes);
  const createMs = performance.now() - createStarted;
  runOnce(vm);
  const quickjsHeapBytes = vm.runtime.memoryUsedBytes().toString();
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < args.iterations; i++) runOnce(vm);
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const rssDeltaBytes = rss() - beforeRss;
  disposeVm(vm);
  collect();
  const cpuMicros = cpu.user + cpu.system;
  return {
    createMs,
    rssDeltaBytes,
    quickjsHeapBytes,
    evalsPerSecond: rate(args.iterations, wallMs),
    cpuMicrosPerEval: cpuMicros / args.iterations,
  };
}

function measureLiveVmGrowth(args: Args, library: QuickJS, rssStart: number): Sample[] {
  const vms: JSContext[] = [];
  const samples: Sample[] = [];
  try {
    for (let count = 1; count <= args.maxVms; count++) {
      const vm = createVm(library, args.memoryBytes);
      runOnce(vm);
      vms.push(vm);
      if (count === 1 || count % args.step === 0 || count === args.maxVms) {
        collect();
        samples.push(sample(count, vms, rssStart));
      }
    }
    return samples;
  } finally {
    for (const vm of vms) disposeVm(vm);
    collect();
  }
}

function measureActiveVmEval(
  args: Args,
  library: QuickJS,
  rssStart: number,
): Report["activeVmEval"] {
  const vms = Array.from({ length: args.maxVms }, () => createVm(library, args.memoryBytes));
  try {
    const totalEvals = args.maxVms * args.iterations;
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    for (const vm of vms) {
      for (let i = 0; i < args.iterations; i++) runOnce(vm);
    }
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    return {
      vms: args.maxVms,
      iterationsPerVm: args.iterations,
      totalEvals,
      wallMs,
      cpuMs: {
        user: cpu.user / 1000,
        system: cpu.system / 1000,
      },
      evalsPerSecond: rate(totalEvals, wallMs),
      rssDeltaBytes: rss() - rssStart,
    };
  } finally {
    for (const vm of vms) disposeVm(vm);
    collect();
  }
}

async function measureParallelProcessEval(args: Args): Promise<Report["parallelProcessEval"]> {
  const started = performance.now();
  const workers = await Promise.all(
    Array.from({ length: args.parallelWorkers }, () => runWorker(args)),
  );
  const wallMs = performance.now() - started;
  const totalEvals = workers.reduce((sum, worker) => sum + worker.totalEvals, 0);
  const rssDeltaBytes = workers.reduce((sum, worker) => sum + worker.rssDeltaBytes, 0);
  const quickjsHeapBytes = workers
    .reduce((sum, worker) => sum + BigInt(worker.quickjsHeapBytes), 0n)
    .toString();
  return {
    workers: args.parallelWorkers,
    vmsPerWorker: args.parallelVmsPerWorker,
    totalVms: args.parallelWorkers * args.parallelVmsPerWorker,
    iterationsPerVm: args.iterations,
    totalEvals,
    wallMs,
    cpuMs: {
      user: workers.reduce((sum, worker) => sum + worker.cpuMs.user, 0),
      system: workers.reduce((sum, worker) => sum + worker.cpuMs.system, 0),
    },
    evalsPerSecond: rate(totalEvals, wallMs),
    rssDeltaBytes,
    quickjsHeapBytes,
  };
}

async function runWorker(args: Args): Promise<WorkerReport> {
  const proc = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      "--stress-worker",
      "--vms",
      String(args.parallelVmsPerWorker),
      "--iterations",
      String(args.iterations),
      "--memory-bytes",
      String(args.memoryBytes),
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  assert.equal(exitCode, 0, stderr || stdout);
  assert.equal(stderr, "");
  return JSON.parse(stdout) as WorkerReport;
}

interface WorkerArgs {
  vms: number;
  iterations: number;
  memoryBytes: number;
}

interface WorkerReport extends WorkerArgs {
  totalEvals: number;
  wallMs: number;
  cpuMs: Cpu;
  rssBytes: number;
  rssDeltaBytes: number;
  quickjsHeapBytes: string;
}

function parseWorkerArgs(): WorkerArgs {
  const { values } = parseNodeArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    options: {
      "stress-worker": { type: "boolean", default: false },
      vms: { type: "string" },
      iterations: { type: "string" },
      "memory-bytes": { type: "string" },
    },
  });
  assert(values["stress-worker"], "--stress-worker is required");
  return {
    vms: readPositiveInteger("--vms", values.vms),
    iterations: readPositiveInteger("--iterations", values.iterations),
    memoryBytes: readPositiveInteger("--memory-bytes", values["memory-bytes"]),
  };
}

function measureWorkerEval(args: WorkerArgs): WorkerReport {
  using library = new QuickJS();
  collect();
  const rssStart = rss();
  const vms = Array.from({ length: args.vms }, () => createVm(library, args.memoryBytes));
  try {
    for (const vm of vms) runOnce(vm);
    const totalEvals = args.vms * args.iterations;
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    for (const vm of vms) {
      for (let i = 0; i < args.iterations; i++) runOnce(vm);
    }
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    return {
      ...args,
      totalEvals,
      wallMs,
      cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
      rssBytes: rss(),
      rssDeltaBytes: rss() - rssStart,
      quickjsHeapBytes: vms.reduce((sum, vm) => sum + vm.runtime.memoryUsedBytes(), 0n).toString(),
    };
  } finally {
    for (const vm of vms) disposeVm(vm);
    collect();
  }
}

function createVm(library: QuickJS, memoryBytes: number): JSContext {
  const runtime = new JSRuntime({ library, memoryBytes });
  return runtime.createContext();
}

function disposeVm(vm: JSContext): void {
  vm.runtime.dispose();
}

function runOnce(vm: JSContext): void {
  using result = vm.evalCode(code);
  assert.equal(result.toNumber(), 4950);
}

function sample(count: number, vms: JSContext[], rssStart: number): Sample {
  return {
    vms: count,
    rssBytes: rss(),
    rssDeltaBytes: rss() - rssStart,
    quickjsHeapBytes: vms.reduce((sum, vm) => sum + vm.runtime.memoryUsedBytes(), 0n).toString(),
  };
}

function rss(): number {
  return process.memoryUsage().rss;
}

function collect(): void {
  Bun.gc(true);
}

function rate(count: number, wallMs: number): number {
  return count / (wallMs / 1000);
}

function printReport(report: Report): void {
  console.log(
    `quickjs-bun stress (${report.runtime.platform}/${report.runtime.arch}, Bun ${report.runtime.bun}, ${report.runtime.cpus} CPUs)`,
  );
  console.log(
    `options: maxVms=${report.options.maxVms} step=${report.options.step} ` +
      `iterations=${report.options.iterations} memoryBytes=${report.options.memoryBytes} ` +
      `parallelWorkers=${report.options.parallelWorkers} ` +
      `parallelVmsPerWorker=${report.options.parallelVmsPerWorker}`,
  );
  console.log("");
  console.log("single VM");
  console.log(`  createMs=${report.singleVm.createMs.toFixed(2)}`);
  console.log(`  rssDelta=${formatBytes(report.singleVm.rssDeltaBytes)}`);
  console.log(`  quickjsHeap=${formatBytes(Number(report.singleVm.quickjsHeapBytes))}`);
  console.log(`  evalsPerSecond=${report.singleVm.evalsPerSecond.toFixed(0)}`);
  console.log(`  cpuMicrosPerEval=${report.singleVm.cpuMicrosPerEval.toFixed(1)}`);
  console.log("");
  console.log("live VM growth");
  for (const sample of report.liveVmGrowth) {
    console.log(
      `  vms=${sample.vms} rssDelta=${formatBytes(sample.rssDeltaBytes)} ` +
        `quickjsHeap=${formatBytes(Number(sample.quickjsHeapBytes))}`,
    );
  }
  console.log("");
  console.log("active VM eval sweep");
  console.log(`  vms=${report.activeVmEval.vms}`);
  console.log(`  totalEvals=${report.activeVmEval.totalEvals}`);
  console.log(`  wallMs=${report.activeVmEval.wallMs.toFixed(2)}`);
  console.log(
    `  cpuMs=${(report.activeVmEval.cpuMs.user + report.activeVmEval.cpuMs.system).toFixed(2)}`,
  );
  console.log(`  evalsPerSecond=${report.activeVmEval.evalsPerSecond.toFixed(0)}`);
  console.log(`  rssDelta=${formatBytes(report.activeVmEval.rssDeltaBytes)}`);
  console.log("");
  console.log("parallel process eval");
  console.log(`  workers=${report.parallelProcessEval.workers}`);
  console.log(`  totalVms=${report.parallelProcessEval.totalVms}`);
  console.log(`  totalEvals=${report.parallelProcessEval.totalEvals}`);
  console.log(`  wallMs=${report.parallelProcessEval.wallMs.toFixed(2)}`);
  console.log(
    `  cpuMs=${(report.parallelProcessEval.cpuMs.user + report.parallelProcessEval.cpuMs.system).toFixed(2)}`,
  );
  console.log(`  evalsPerSecond=${report.parallelProcessEval.evalsPerSecond.toFixed(0)}`);
  console.log(`  rssDelta=${formatBytes(report.parallelProcessEval.rssDeltaBytes)}`);
  console.log(`  quickjsHeap=${formatBytes(Number(report.parallelProcessEval.quickjsHeapBytes))}`);
}

function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  for (const unit of ["B", "KiB", "MiB", "GiB"]) {
    if (value < 1024 || unit === "GiB")
      return `${sign}${value.toFixed(unit === "B" ? 0 : 2)} ${unit}`;
    value /= 1024;
  }
  throw new Error("unreachable");
}

if (import.meta.main) await main();
