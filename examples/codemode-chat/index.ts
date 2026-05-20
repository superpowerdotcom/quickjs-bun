import assert from "node:assert/strict";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message,
  type Tool as BedrockTool,
  type ToolResultBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import {
  QuickJS,
  JSException,
  QuickJSEvalFlags,
  QuickJSPromiseState,
  JSRuntime,
  type Deferred,
  type HostValue,
  type JSValue,
  type JSContext,
} from "../../index";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface ToolContext {
  signal: AbortSignal;
}
interface ToolDefinition<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: Schema;
  run(input: z.infer<Schema>, context: ToolContext): HostValue | Promise<HostValue>;
}
interface ToolProvider {
  namespace: string;
  description: string;
  tools: ToolDefinition[];
}
type ExecuteResult =
  | { ok: true; result: unknown; durationMs: number }
  | {
      ok: false;
      error: string;
      durationMs: number;
    };
interface PendingToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
  inputError?: string;
}
interface ReasoningDelta {
  text?: string;
  signature?: string;
  redactedContent?: Uint8Array;
}
type BedrockContent = NonNullable<Message["content"]>[number];
type ToolUseBlock = Extract<BedrockContent, { toolUse: unknown }>;
type ToolContent = Extract<BedrockContent, { toolResult: unknown }>;
type BedrockBlock = BedrockContent & { toolUse?: PendingToolCall };
interface ToolTask {
  controller: AbortController;
  deferred: Deferred;
  settled: Promise<void>;
  settle: () => void;
  timeout: ReturnType<typeof setTimeout>;
}
interface Args {
  code?: string;
  demo: boolean;
  evalTimeoutMs: number;
  help: boolean;
  maxHostCalls: number;
  maxMicrotasks: number;
  maxToolRounds: number;
  networkTools: boolean;
  toolTimeoutMs: number;
}

function defineTool<Schema extends z.ZodType>(
  definition: ToolDefinition<Schema>,
): ToolDefinition<Schema> {
  return definition;
}

const SYSTEM_PROMPT = `
You have access to a persistent JavaScript REPL through quickjs_repl. Use it
only when you need to inspect data or call tools. The REPL supports top-level
await and returns the value of the last expression.

Keep snippets small. Do not wrap code in an async function. Do not assume Bun,
Node.js, filesystem, timers, console, or direct network access exist in the
sandbox.
`.trim();

const USAGE = `
Usage:
  bun examples/codemode-chat.ts --demo
  bun examples/codemode-chat.ts --code 'await notes.list()'
  bun examples/codemode-chat.ts

Options:
  --code <js>              Run one snippet in the QuickJS sandbox.
  --demo                   Run a deterministic local demo.
  --network-tools          Install weather and wiki host tools for --code.
  --eval-timeout-ms <n>    QuickJS execution timeout. Default: 2000.
  --max-host-calls <n>     Maximum host tool calls per snippet. Default: 256.
  --max-microtasks <n>     Maximum microtasks per snippet. Default: 10000.
  --max-tool-rounds <n>    Maximum Bedrock tool rounds in chat mode. Default: 8.
  --tool-timeout-ms <n>    Per-tool host timeout. Default: 8000.
  -h, --help               Show this help.
`.trim();

const BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
const BEDROCK_ADAPTIVE_THINKING = {
  thinking: { type: "adaptive" },
  output_config: { effort: "max" },
} as const;
const runCodeTool: BedrockTool = {
  toolSpec: {
    name: "quickjs_repl",
    description:
      "Evaluate JavaScript in a persistent QuickJS REPL. Top-level await is supported and the last expression value is returned.",
    inputSchema: {
      json: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: {
          code: {
            type: "string",
            description: "JavaScript to evaluate. Keep it small; the final expression is returned.",
          },
        },
      },
    },
  },
};

const codeInputSchema = z.object({ code: z.string().min(1) });
const textInputSchema = z.object({ text: z.string().min(1) });
const cityInputSchema = z.object({ city: z.string().min(1) });
const topicInputSchema = z.object({ topic: z.string().min(1) });
const geocodeSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        country: z.string().optional(),
        latitude: z.number(),
        longitude: z.number(),
      }),
    )
    .optional(),
});
const forecastSchema = z.object({
  current: z.record(z.string(), z.union([z.null(), z.boolean(), z.number(), z.string()])),
});
const wikiSummarySchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  extract: z.string().optional(),
  content_urls: z
    .object({
      desktop: z.object({ page: z.string().optional() }).optional(),
    })
    .optional(),
});

class CodemodeSandbox {
  #tasks = new Set<ToolTask>();
  #disposed = false;
  #remainingHostCalls: number | undefined;

  constructor(
    readonly vm: JSContext,
    readonly providers: readonly ToolProvider[],
    readonly evalTimeoutMs: number,
    readonly maxHostCalls: number,
    readonly maxMicrotasks: number,
    readonly toolTimeoutMs: number,
  ) {
    for (const provider of providers) this.#install(provider);
  }

  async execute(code: string): Promise<ExecuteResult> {
    const started = performance.now();
    try {
      assert(this.#remainingHostCalls === undefined, "Codemode sandbox is already executing");
      this.#remainingHostCalls = this.maxHostCalls;
      if (code.trim().length === 0) throw new Error("Code is empty");
      using result = this.vm.evalCode(code, {
        filename: "<codemode>",
        flags: QuickJSEvalFlags.TYPE_GLOBAL | QuickJSEvalFlags.ASYNC,
      });
      let value: JSValue;
      if (result.promiseState === QuickJSPromiseState.NOT_PROMISE) {
        value = result.dup();
      } else {
        let microtasks = 0;
        while (result.promiseState === QuickJSPromiseState.PENDING) {
          if (this.vm.runtime.executePendingJob(this.evalTimeoutMs)) {
            microtasks++;
            if (microtasks > this.maxMicrotasks) {
              throw new Error(`Exceeded ${this.maxMicrotasks} microtasks in one snippet`);
            }
            continue;
          }
          const tasks = [...this.#tasks];
          if (tasks.length === 0)
            throw new Error("QuickJS promise is pending with no host work to run");
          await Promise.race(tasks.map((task) => task.settled));
        }
        value = result.promiseResult();
        if (result.promiseState === QuickJSPromiseState.REJECTED) throw new JSException(value);
      }
      using owned = value;
      return {
        ok: true,
        result: unwrapAsyncValue(this.vm.dump(owned)),
        durationMs: elapsed(started),
      };
    } catch (error) {
      if (error instanceof JSException) error.dispose();
      const message = errorMessage(error);
      return {
        ok: false,
        error:
          message === "interrupted"
            ? `QuickJS execution timed out after ${this.evalTimeoutMs}ms`
            : message,
        durationMs: elapsed(started),
      };
    } finally {
      this.#remainingHostCalls = undefined;
      this.#abortTasks();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortTasks();
  }

  #abortTasks(): void {
    for (const task of this.#tasks) {
      task.controller.abort();
      clearTimeout(task.timeout);
      task.deferred.dispose();
      task.settle();
    }
    this.#tasks.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #install(provider: ToolProvider): void {
    using namespace = this.vm.newObject();
    for (const tool of provider.tools) {
      using fn = this.vm.newFunction((...args) => this.#runTool(tool, args[0]));
      namespace.setProp(tool.name, fn);
    }
    this.vm.setGlobal(provider.namespace, namespace);
  }

  #runTool(tool: ToolDefinition, arg: JSValue | undefined) {
    assert(
      this.#remainingHostCalls !== undefined,
      "Host tool called outside an active QuickJS execution",
    );
    if (this.#remainingHostCalls === 0) {
      throw new Error(`Exceeded ${this.maxHostCalls} host tool calls in one snippet`);
    }
    this.#remainingHostCalls--;

    const deferred = this.vm.newPromise();
    const promise = deferred.promise.dup();
    const controller = new AbortController();
    let task: ToolTask;
    let settleTask!: () => void;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(task.timeout);
      this.#tasks.delete(task);
      deferred.dispose();
      task.settle();
    };
    const reject = (error: unknown) => {
      using handle = this.vm.newError(error instanceof Error ? error : new Error(String(error)));
      deferred.reject(handle);
    };

    task = {
      controller,
      deferred,
      settled: new Promise<void>((resolve) => {
        settleTask = resolve;
      }),
      settle: () => settleTask(),
      timeout: setTimeout(() => {
        if (!this.#tasks.has(task)) return;
        controller.abort();
        reject(new Error(`Tool "${tool.name}" timed out after ${this.toolTimeoutMs}ms`));
        finish();
      }, this.toolTimeoutMs),
    };
    this.#tasks.add(task);

    let input: unknown;
    try {
      input = tool.schema.parse(
        arg === undefined || arg.type === "undefined" ? {} : this.vm.dump(arg),
      );
    } catch (error) {
      reject(error);
      finish();
      return promise;
    }

    void this.#settleTool(tool, input, task, deferred, finish, reject);

    return promise;
  }

  async #settleTool(
    tool: ToolDefinition,
    input: unknown,
    task: ToolTask,
    deferred: Deferred,
    finish: () => void,
    reject: (error: unknown) => void,
  ): Promise<void> {
    try {
      const value = await tool.run(input, { signal: task.controller.signal });
      if (this.#disposed || !this.#tasks.has(task)) return;
      using handle = this.vm.newValue(value);
      deferred.resolve(handle);
    } catch (error) {
      if (!this.#disposed && this.#tasks.has(task)) reject(error);
    } finally {
      finish();
    }
  }
}

function defaultProviders(networkTools: boolean): ToolProvider[] {
  const notes: string[] = [];
  const local: ToolProvider = {
    namespace: "notes",
    description: "In-memory notes provider.",
    tools: [
      defineTool({
        name: "remember",
        description: "Store a note.",
        schema: textInputSchema,
        run({ text }) {
          notes.push(text);
          return { ok: true, count: notes.length };
        },
      }),
      defineTool({
        name: "list",
        description: "List stored notes.",
        schema: z.object({}).default({}),
        run() {
          return { notes: [...notes] };
        },
      }),
      defineTool({
        name: "clear",
        description: "Clear stored notes.",
        schema: z.object({}).default({}),
        run() {
          notes.length = 0;
          return { ok: true };
        },
      }),
    ],
  };
  if (!networkTools) return [local];
  return [weatherProvider, wikiProvider, local];
}

const weatherProvider: ToolProvider = {
  namespace: "weather",
  description: "Weather provider backed by Open-Meteo.",
  tools: [
    defineTool({
      name: "forecast",
      description: "Return a current weather forecast for a city.",
      schema: cityInputSchema,
      async run({ city }, { signal }) {
        const geo = await fetchJson(
          geocodeSchema,
          "https://geocoding-api.open-meteo.com/v1/search",
          {
            signal,
            query: { name: city, count: "1", language: "en", format: "json" },
          },
        );
        const place = geo.results?.[0];
        if (!place) throw new Error(`No weather location found for ${city}`);
        const forecast = await fetchJson(forecastSchema, "https://api.open-meteo.com/v1/forecast", {
          signal,
          query: {
            latitude: String(place.latitude),
            longitude: String(place.longitude),
            current:
              "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
          },
        });
        return {
          city: place.name,
          country: place.country ?? null,
          latitude: place.latitude,
          longitude: place.longitude,
          current: forecast.current as Json,
        };
      },
    }),
  ],
};

const wikiProvider: ToolProvider = {
  namespace: "wiki",
  description: "Wikipedia summary provider.",
  tools: [
    defineTool({
      name: "summary",
      description: "Return a Wikipedia summary for a topic.",
      schema: topicInputSchema,
      async run({ topic }, { signal }) {
        const data = await fetchJson(
          wikiSummarySchema,
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`,
          {
            signal,
          },
        );
        return {
          title: data.title,
          description: data.description ?? null,
          extract: data.extract ?? null,
          url: data.content_urls?.desktop?.page ?? null,
        };
      },
    }),
  ],
};

async function chatTurn(
  client: BedrockRuntimeClient,
  modelId: string,
  maxToolRounds: number,
  sandbox: CodemodeSandbox,
  messages: Message[],
  text: string,
): Promise<void> {
  messages.push({ role: "user", content: [{ text }] });

  for (let round = 0; round < maxToolRounds; round++) {
    const { message, toolUses } = await streamAssistantMessage(
      client,
      modelId,
      messages,
      systemPrompt(sandbox.providers),
    );
    messages.push(message);
    if (toolUses.length === 0) return;

    const toolResults: ToolContent[] = [];
    for (const toolUse of toolUses) {
      toolResults.push(await runToolUse(sandbox, toolUse));
    }
    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(`Exceeded ${maxToolRounds} tool rounds`);
}

async function runToolUse(
  sandbox: CodemodeSandbox,
  toolUse: PendingToolCall,
): Promise<ToolContent> {
  if (toolUse.inputError) return toolResult(toolUse.toolUseId, "error", toolUse.inputError);
  if (toolUse.name !== "quickjs_repl")
    return toolResult(toolUse.toolUseId, "error", `Unknown tool: ${toolUse.name}`);

  try {
    const { code } = codeInputSchema.parse(toolUse.input);
    console.log(`\n[quickjs]\n${code}\n`);
    const result = await sandbox.execute(code);
    const text = formatValue(result);
    console.log(`[result]\n${text}\n`);
    return toolResult(toolUse.toolUseId, result.ok ? "success" : "error", text);
  } catch (error) {
    return toolResult(toolUse.toolUseId, "error", errorMessage(error));
  }
}

async function streamAssistantMessage(
  client: BedrockRuntimeClient,
  modelId: string,
  messages: Message[],
  systemPromptText: string,
): Promise<{ message: Message; toolUses: PendingToolCall[] }> {
  const response = await client.send(
    new ConverseStreamCommand({
      modelId,
      system: [{ text: systemPromptText }],
      messages,
      toolConfig: { tools: [runCodeTool] },
      additionalModelRequestFields: BEDROCK_ADAPTIVE_THINKING,
    }),
  );

  const blocks = new Map<number, BedrockBlock>();
  let section: string | undefined;
  const writeSection = (name: string) => {
    if (section === name) return;
    if (section !== undefined) output.write("\n");
    output.write(`\n[${name}]\n`);
    section = name;
  };

  assert(response.stream !== undefined, "Bedrock response stream is missing");
  for await (const event of response.stream) {
    if (event.messageStart) {
      assert(event.messageStart.role === "assistant", "message role must be assistant");
      console.log(`\n[message:start ${event.messageStart.role}]`);
    }

    if (event.contentBlockStart) {
      const index = event.contentBlockStart.contentBlockIndex;
      assert(index !== undefined, "content block index is missing");
      const toolUse = event.contentBlockStart.start?.toolUse;
      if (toolUse) {
        assert(toolUse.toolUseId && toolUse.name, "tool use id/name is missing");
        writeSection(`tool:${toolUse.name}`);
        output.write(`id=${toolUse.toolUseId}\ninput> `);
        blocks.set(index, {
          toolUse: {
            toolUseId: toolUse.toolUseId,
            name: toolUse.name,
            input: "",
          },
        });
      }
    }

    if (event.contentBlockDelta) {
      const index = event.contentBlockDelta.contentBlockIndex;
      assert(index !== undefined, "content block index is missing");
      const delta = event.contentBlockDelta.delta;
      if (delta?.text) {
        writeSection("text");
        output.write(delta.text);
        const existing = blocks.get(index);
        assert(
          existing === undefined || "text" in existing,
          "text delta changed content block type",
        );
        blocks.set(index, { text: `${existing?.text ?? ""}${delta.text}` });
      }
      if (delta?.reasoningContent) {
        appendReasoning(blocks, index, delta.reasoningContent, writeSection);
      }
      if (delta?.toolUse?.input !== undefined) {
        const block = blocks.get(index);
        assert(isToolUse(block), "tool input arrived before tool start");
        writeSection(`tool:${block.toolUse.name}`);
        output.write(delta.toolUse.input);
        block.toolUse.input = `${toolInputText(block.toolUse.input)}${delta.toolUse.input}`;
      }
    }

    if (event.contentBlockStop) {
      const index = event.contentBlockStop.contentBlockIndex;
      assert(index !== undefined && blocks.has(index), "content block stopped before start");
      if (isToolUse(blocks.get(index))) output.write("\n");
      section = undefined;
    }

    if (event.messageStop) {
      console.log(`\n[message:stop ${event.messageStop.stopReason ?? "unknown"}]`);
      section = undefined;
    }

    if (event.metadata) {
      logMetadata(event.metadata);
      section = undefined;
    }
  }

  if (section !== undefined) output.write("\n");
  const content = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => {
      if (isToolUse(block))
        Object.assign(block.toolUse, parseToolInput(toolInputText(block.toolUse.input)));
      return block as BedrockContent;
    });
  return {
    message: { role: "assistant", content },
    toolUses: content.filter(isToolUse).map((block) => block.toolUse),
  };
}

function appendReasoning(
  blocks: Map<number, BedrockBlock>,
  index: number,
  reasoning: ReasoningDelta,
  writeSection: (name: string) => void,
): void {
  if (reasoning.text !== undefined) {
    writeSection("reasoning");
    output.write(reasoning.text);
    const existing = blocks.get(index);
    const current =
      existing && "reasoningContent" in existing
        ? existing.reasoningContent?.reasoningText
        : undefined;
    blocks.set(index, {
      reasoningContent: {
        reasoningText: {
          text: `${current?.text ?? ""}${reasoning.text}`,
          signature: reasoning.signature ?? current?.signature,
        },
      },
    });
  }
  if (reasoning.redactedContent !== undefined) {
    blocks.set(index, {
      reasoningContent: { redactedContent: reasoning.redactedContent },
    });
    console.log(`\n[reasoning:redacted ${reasoning.redactedContent.byteLength} bytes]`);
  }
}

function logMetadata(metadata: {
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  metrics?: { latencyMs?: number };
}): void {
  const usage = metadata.usage;
  const latencyMs = metadata.metrics?.latencyMs;
  console.log(
    `[metadata input=${usage?.inputTokens ?? "?"} output=${usage?.outputTokens ?? "?"} ` +
      `total=${usage?.totalTokens ?? "?"} latencyMs=${latencyMs ?? "?"}]`,
  );
}

function isToolUse(
  block: BedrockBlock | BedrockContent | undefined,
): block is ToolUseBlock & { toolUse: PendingToolCall } {
  return block !== undefined && "toolUse" in block;
}

function systemPrompt(providers: readonly ToolProvider[]): string {
  return `${SYSTEM_PROMPT}\n\n${toolTypeDeclarations(providers)}`;
}

function toolTypeDeclarations(providers: readonly ToolProvider[]): string {
  const lines = [
    "Available globals:",
    "```ts",
    "type Json = null | boolean | number | string | Json[] | { [key: string]: Json };",
  ];
  for (const provider of providers) {
    lines.push(`/** ${provider.description} */`);
    lines.push(`declare const ${provider.namespace}: {`);
    for (const tool of provider.tools) {
      lines.push(`  /** ${tool.description} */`);
      lines.push(`  /** input schema: ${JSON.stringify(z.toJSONSchema(tool.schema))} */`);
      lines.push(`  ${tool.name}(input?: Record<string, Json>): Promise<Json>;`);
    }
    lines.push("};");
  }
  lines.push("```");
  return lines.join("\n");
}

function parseToolInput(text: string): { input: unknown; inputError?: string } {
  try {
    return { input: text.length === 0 ? {} : JSON.parse(text) };
  } catch (error) {
    return {
      input: {},
      inputError: `Invalid tool input JSON: ${errorMessage(error)}`,
    };
  }
}

function toolInputText(input: unknown): string {
  assert(typeof input === "string", "streamed tool input must be a string");
  return input;
}

function toolResult(
  toolUseId: string,
  status: ToolResultBlock["status"],
  text: string,
): ToolContent {
  return { toolResult: { toolUseId, status, content: [{ text }] } };
}

async function fetchJson<Schema extends z.ZodType>(
  schema: Schema,
  url: string,
  options: { signal: AbortSignal; query?: Record<string, string> },
): Promise<z.infer<Schema>> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {}))
    target.searchParams.set(key, value);
  const response = await fetch(target, {
    signal: options.signal,
    headers: {
      accept: "application/json",
      "user-agent": "quickjs-bun-codemode-example/1.0",
    },
  });
  if (!response.ok)
    throw new Error(`${target.hostname} returned ${response.status} ${response.statusText}`);
  return schema.parse(await response.json());
}

function parseCliArgs(args = process.argv.slice(2)): Args {
  if (args.includes("--help") || args.includes("-h")) {
    return {
      demo: false,
      evalTimeoutMs: 2_000,
      help: true,
      maxHostCalls: 256,
      maxMicrotasks: 10_000,
      maxToolRounds: 8,
      networkTools: false,
      toolTimeoutMs: 8_000,
    };
  }

  const { values } = parseNodeArgs({
    args,
    allowPositionals: false,
    options: {
      code: { type: "string" },
      demo: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "eval-timeout-ms": { type: "string", default: "2000" },
      "max-host-calls": { type: "string", default: "256" },
      "max-microtasks": { type: "string", default: "10000" },
      "max-tool-rounds": { type: "string", default: "8" },
      "network-tools": { type: "boolean", default: false },
      "tool-timeout-ms": { type: "string", default: "8000" },
    },
  });

  const readInteger = (name: string, raw: string | undefined) => {
    assert(raw !== undefined, `${name} needs a value`);
    const value = Number(raw);
    assert(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
    return value;
  };

  const parsed: Args = {
    code: values.code,
    demo: values.demo,
    evalTimeoutMs: readInteger("--eval-timeout-ms", values["eval-timeout-ms"]),
    help: values.help,
    maxHostCalls: readInteger("--max-host-calls", values["max-host-calls"]),
    maxMicrotasks: readInteger("--max-microtasks", values["max-microtasks"]),
    maxToolRounds: readInteger("--max-tool-rounds", values["max-tool-rounds"]),
    networkTools: values["network-tools"],
    toolTimeoutMs: readInteger("--tool-timeout-ms", values["tool-timeout-ms"]),
  };
  assert(!(parsed.demo && parsed.code !== undefined), "Use either --demo or --code, not both");
  return parsed;
}

async function runDemo(sandbox: CodemodeSandbox): Promise<ExecuteResult> {
  const result = await sandbox.execute(`
await notes.clear();
await notes.remember({ text: "Codemode keeps state inside one QuickJS VM" });
const saved = await notes.list();
({ ok: true, note: saved.notes[0], arithmetic: 20 + 22 });
`);
  console.log(formatValue(result));
  return result;
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const chatMode = args.code === undefined && !args.demo;
  if (chatMode && !input.isTTY)
    throw new Error(
      "Chat mode needs an interactive terminal; use --demo or --code for non-interactive runs.",
    );

  using quickjs = new QuickJS();
  using runtime = new JSRuntime({ library: quickjs });
  using vm = runtime.createContext({ timeoutMs: args.evalTimeoutMs });
  using sandbox = new CodemodeSandbox(
    vm,
    defaultProviders(args.networkTools || chatMode),
    args.evalTimeoutMs,
    args.maxHostCalls,
    args.maxMicrotasks,
    args.toolTimeoutMs,
  );
  if (args.code !== undefined) {
    const result = await sandbox.execute(args.code);
    console.log(formatValue(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (args.demo) {
    const result = await runDemo(sandbox);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  await chat(sandbox, args);
}

async function chat(sandbox: CodemodeSandbox, args: Args): Promise<void> {
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
  });
  const modelId = process.env.BEDROCK_MODEL_ID ?? BEDROCK_MODEL_ID;
  const messages: Message[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    console.log("codemode chat. Type .exit to quit, .demo for a local run.");
    for (;;) {
      const line = (await rl.question("you> ")).trim();
      if (line === ".exit") break;
      if (line === ".demo") {
        await runDemo(sandbox);
      } else if (line.length > 0) {
        await chatTurn(client, modelId, args.maxToolRounds, sandbox, messages, line);
      }
    }
  } finally {
    rl.close();
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

function elapsed(started: number): number {
  return performance.now() - started;
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
