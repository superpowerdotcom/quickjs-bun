import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  section,
  watchEvents,
} from "@earendil-works/pi-durable";
import {
  JSException,
  JSRuntime,
  QuickJS,
  QuickJSEvalFlags,
  QuickJSPromiseState,
  type HostValue,
} from "../../index";

using library = new QuickJS();
using runtime = new JSRuntime({ library, memoryBytes: 64 * 1024 * 1024 });
using vm = runtime.createContext({ timeoutMs: 2_000 });
const pending = new Set<Promise<void>>();
const notes: string[] = [];

function hostTool(run: (input: unknown) => Promise<HostValue>) {
  return vm.newFunction((input) => {
    const deferred = vm.newPromise();
    const task = run(input === undefined ? undefined : vm.dump(input))
      .then(
        (value) => {
          using handle = vm.newValue(value);
          deferred.resolve(handle);
        },
        (error: unknown) => {
          using handle = vm.newError(error instanceof Error ? error : new Error(String(error)));
          deferred.reject(handle);
        },
      )
      .finally(() => {
        deferred.dispose();
        pending.delete(task);
      });
    pending.add(task);
    return deferred.promise.dup();
  });
}

using tools = vm.newObject();
using remember = hostTool(async (text) => {
  notes.push(String(text));
  return { count: notes.length };
});
using list = hostTool(async () => [...notes]);
using wiki = hostTool(async (topic) => {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(topic))}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`wikipedia returned ${response.status}`);
  const { title, extract } = (await response.json()) as { title: string; extract: string };
  return { title, extract };
});
tools.setProp("remember", remember);
tools.setProp("list", list);
tools.setProp("wiki", wiki);
vm.setGlobal("tools", tools);

async function evaluate(code: string): Promise<unknown> {
  using result = vm.evalCode(code, {
    filename: "<repl>",
    flags: QuickJSEvalFlags.TYPE_GLOBAL | QuickJSEvalFlags.ASYNC,
  });
  while (result.promiseState === QuickJSPromiseState.PENDING) {
    if (runtime.executePendingJob()) continue;
    if (pending.size === 0) throw new Error("the snippet is waiting on nothing");
    await Promise.race(pending);
  }
  using settled = result.promiseResult();
  if (result.promiseState === QuickJSPromiseState.REJECTED) throw new JSException(settled.dup());
  return (vm.dump(settled) as { value: unknown }).value;
}

const repl = defineTool({
  name: "quickjs_repl",
  description:
    "Evaluate JavaScript in a persistent QuickJS REPL with top-level await; the last expression is returned. " +
    "Globals: tools.remember(text), tools.list(), tools.wiki(topic), all async.",
  parameters: Type.Object({ code: Type.String() }),
  async execute({ code }) {
    console.log(`\n[quickjs]\n${code}`);
    try {
      const text = Bun.inspect(await evaluate(code), { depth: 10 });
      console.log(`[result] ${text}`);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.log(`[error] ${text}`);
      return { content: [{ type: "text", text }], isError: true };
    }
  },
});

const anthropic = process.env.ANTHROPIC_API_KEY !== undefined;
const models = createModels();
models.setProvider(anthropic ? anthropicProvider() : amazonBedrockProvider());
const registry = createRegistry();
registry.install(
  defineExtension({
    name: "codemode",
    tools: [repl],
    sections: [
      section(
        "codemode",
        () =>
          "You have a persistent JavaScript REPL. Use quickjs_repl to compute, inspect data, and call tools; keep snippets small and do not assume Node, Bun, console, timers or network access inside the sandbox.",
        { tag: false },
      ),
    ],
  }),
);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
const root = await harness.root(BACKGROUND_CONTEXT, {
  agent: {
    model: anthropic
      ? { provider: "anthropic", modelId: "claude-sonnet-5-5" }
      : { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-5-5" },
    thinkingLevel: "medium",
  },
});

let printed = "";
const events = await watchEvents(harness, root.id, BACKGROUND_CONTEXT);
events.start(async (batch) => {
  for (const event of batch) {
    if (event.type === "message_start") printed = "";
    if (event.type === "message_update") {
      for (const change of event.changes) {
        if (change.type !== "text_delta") continue;
        printed += change.delta;
        process.stdout.write(change.delta);
      }
    }
    if (event.type === "message_end" && event.entry.model?.[0]?.role === "assistant") {
      const text = event.entry.model[0].content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      if (text.startsWith(printed)) process.stdout.write(text.slice(printed.length));
      process.stdout.write("\n");
    }
  }
});

async function ask(text: string) {
  const submission = await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status === "unanswered") console.error(`unanswered: ${settled.reason}`);
}

if (process.argv[2]) {
  await ask(process.argv.slice(2).join(" "));
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (
    let line = await rl.question("you> ");
    line !== ".exit";
    line = await rl.question("\nyou> ")
  ) {
    if (line.trim()) await ask(line);
  }
  rl.close();
}
await events.stop();
await harness.close(BACKGROUND_CONTEXT);
