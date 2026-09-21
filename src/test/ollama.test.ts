import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../providers/OllamaProvider";
import { CompletionRequest } from "../providers/types";
import { resetGeometryCache, resetStickyWindows } from "../providers/ollamaContext";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetGeometryCache();
  resetStickyWindows();
});

/** A response body carrying these NDJSON lines, as `/api/chat` streams them. */
function ndjson(lines: unknown[]): { ok: boolean; status: number; body: ReadableStream } {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        controller.close();
      },
    }),
  };
}

/**
 * Stand in for a whole Ollama server: the geometry probes the provider makes
 * before a request, then the streamed chat reply itself.
 *
 * `onChat` sees the parsed request body, so tests can assert on what was sent.
 */
function mockOllama(opts: {
  chunks: unknown[];
  modelInfo?: Record<string, unknown>;
  tags?: unknown;
  onChat?: (body: any) => void;
}): void {
  globalThis.fetch = (async (url: string, init: any) => {
    const target = String(url);
    if (target.endsWith("/api/show")) {
      return { ok: true, status: 200, json: async () => ({ model_info: opts.modelInfo ?? {} }) };
    }
    if (target.endsWith("/api/tags")) {
      return { ok: true, status: 200, json: async () => opts.tags ?? { models: [] } };
    }
    opts.onChat?.(JSON.parse(init.body));
    return ndjson(opts.chunks);
  }) as unknown as typeof fetch;
}

/** Make the provider's next call return this Ollama `message` object. */
function mockMessage(message: unknown): void {
  mockOllama({ chunks: [{ message, done: false }, { done: true, prompt_eval_count: 1, eval_count: 1 }] });
}

const baseReq: CompletionRequest = {
  system: "s",
  messages: [{ role: "user", content: "do it" }],
  tools: [
    {
      name: "create_file",
      description: "create",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
  model: "qwen2.5-coder:7b",
};

const provider = new OllamaProvider({ baseUrl: "http://localhost:11434" });

test("uses native structured tool_calls when present", async () => {
  mockMessage({
    role: "assistant",
    content: "",
    tool_calls: [{ function: { name: "create_file", arguments: { path: "a.txt" } } }],
  });
  const res = await provider.complete(baseReq);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, "create_file");
  assert.equal(res.toolCalls[0].input.path, "a.txt");
  assert.equal(res.stopReason, "tool_use");
});

test("recovers a tool call emitted as bare JSON text", async () => {
  mockMessage({ role: "assistant", content: '{"name":"create_file","arguments":{"path":"b.txt"}}' });
  const res = await provider.complete(baseReq);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].input.path, "b.txt");
});

test("recovers a tool call wrapped in <tool_call> tags", async () => {
  mockMessage({
    role: "assistant",
    content: 'Sure. <tool_call>{"name":"create_file","arguments":{"path":"c.txt"}}</tool_call>',
  });
  const res = await provider.complete(baseReq);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].input.path, "c.txt");
});

test("recovers a tool call inside a ```json fence", async () => {
  mockMessage({
    role: "assistant",
    content: '```json\n{"name":"create_file","arguments":{"path":"d.txt"}}\n```',
  });
  const res = await provider.complete(baseReq);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].input.path, "d.txt");
});

test("recovers a tool call embedded in explanatory prose", async () => {
  mockMessage({
    role: "assistant",
    content:
      'I will create the file now. {"name": "create_file", "arguments": {"path": "e.txt", "content": "hi"}}',
  });
  const res = await provider.complete(baseReq);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].input.path, "e.txt");
  assert.equal(res.toolCalls[0].input.content, "hi");
  // The prose remains as text, the JSON is stripped out.
  assert.ok(res.text.includes("I will create the file now."));
  assert.ok(!res.text.includes("create_file"));
});

test("plain assistant text with no tool call is left untouched", async () => {
  mockMessage({ role: "assistant", content: "Here is an explanation with the number 42 in it." });
  const res = await provider.complete(baseReq);
  assert.equal(res.toolCalls.length, 0);
  assert.equal(res.stopReason, "end");
  assert.equal(res.text, "Here is an explanation with the number 42 in it.");
});

test("normalizes stringified arguments from native tool_calls", async () => {
  mockMessage({
    role: "assistant",
    content: "",
    tool_calls: [{ function: { name: "create_file", arguments: '{"path":"f.txt"}' } }],
  });
  const res = await provider.complete(baseReq);
  assert.equal(res.toolCalls[0].input.path, "f.txt");
});

test("assembles streamed content fragments into one reply", async () => {
  mockOllama({
    chunks: [
      { message: { content: "Here " } },
      { message: { content: "is " } },
      { message: { content: "the answer." } },
      { done: true, prompt_eval_count: 7, eval_count: 3 },
    ],
  });
  const res = await provider.complete(baseReq);
  assert.equal(res.text, "Here is the answer.");
  assert.equal(res.usage?.inputTokens, 7);
  assert.equal(res.usage?.outputTokens, 3);
});

test("picks up a tool call that arrives on a later stream chunk", async () => {
  mockOllama({
    chunks: [
      { message: { content: "" } },
      {
        message: {
          content: "",
          tool_calls: [{ function: { name: "create_file", arguments: { path: "s.txt" } } }],
        },
      },
      { done: true },
    ],
  });
  const res = await provider.complete(baseReq);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].input.path, "s.txt");
});

test("builds an Ollama request with a system message and mapped roles", async () => {
  let captured: any;
  mockOllama({ chunks: [{ message: { content: "ok" } }, { done: true }], onChat: (b) => (captured = b) });

  await provider.complete({
    system: "SYS",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", input: { path: "a" } }] },
      { role: "tool", toolResults: [{ callId: "1", content: "file body" }] },
    ],
    tools: [],
    model: "m",
  });

  assert.equal(captured.messages[0].role, "system");
  assert.equal(captured.messages[0].content, "SYS");
  assert.equal(captured.messages[1].role, "user");
  assert.equal(captured.messages[1].content, "hi");
  assert.equal(captured.messages[2].role, "assistant");
  assert.ok(Array.isArray(captured.messages[2].tool_calls));
  assert.equal(captured.messages[3].role, "tool");
  assert.equal(captured.messages[3].content, "file body");
});

test("num_ctx is always set, and sized to the request", async () => {
  const bodies: any[] = [];
  mockOllama({ chunks: [{ message: { content: "ok" } }, { done: true }], onChat: (b) => bodies.push(b) });
  const provider = new OllamaProvider({});

  // Ollama defaults to ~4k and silently truncates past it, so a small request
  // must still ask for a real window, not inherit the default.
  await provider.complete({ system: "s", messages: [], tools: [], model: "m" });
  assert.ok(bodies[0].options.num_ctx >= 8192, "a minimum usable window is requested");

  // A large attachment must push the window up rather than be truncated away —
  // when the model and the machine can carry it. Geometry is unknown here, so
  // there is no ceiling to apply.
  const big = "x".repeat(120_000);
  await provider.complete({
    system: "s",
    messages: [{ role: "user", content: big }],
    tools: [],
    model: "m",
  });
  assert.ok(
    bodies[1].options.num_ctx > bodies[0].options.num_ctx,
    "a bigger prompt must get a bigger window"
  );
  assert.ok(bodies[1].options.num_ctx >= 32768);
});

test("num_ctx never exceeds what the model and the machine can carry", async () => {
  const bodies: any[] = [];
  // qwen2.5-coder:14b as installed: 48 layers, 8 KV heads, 128-wide heads,
  // 32k trained context, 9.0GB of weights. A 32k KV cache costs 6.0GB, which on
  // a 16GB machine pushes it off the GPU — the exact case that used to time out.
  mockOllama({
    chunks: [{ message: { content: "ok" } }, { done: true }],
    modelInfo: {
      "qwen2.context_length": 32768,
      "qwen2.block_count": 48,
      "qwen2.attention.head_count": 40,
      "qwen2.attention.head_count_kv": 8,
      "qwen2.embedding_length": 5120,
    },
    tags: { models: [{ name: "qwen2.5-coder:14b", size: 8_988_124_298 }] },
    onChat: (b) => bodies.push(b),
  });

  const res = await new OllamaProvider({}).complete({
    system: "s".repeat(400_000),
    messages: [],
    tools: [],
    model: "qwen2.5-coder:14b",
  });

  assert.ok(
    bodies[0].options.num_ctx <= 16384,
    `a 16GB machine must not be asked for a 32k window (got ${bodies[0].options.num_ctx})`
  );
  // Silently dropping half the prompt is what made this fail invisibly before.
  assert.ok(res.warnings?.length, "a prompt that will not fit must be reported");
});

test("the window never shrinks mid-session, so Ollama does not reload the model", async () => {
  const bodies: any[] = [];
  mockOllama({ chunks: [{ message: { content: "ok" } }, { done: true }], onChat: (b) => bodies.push(b) });
  const provider = new OllamaProvider({});

  const big = "x".repeat(120_000);
  await provider.complete({ system: big, messages: [], tools: [], model: "m" });
  // A short follow-up would size down to the minimum on its own; holding the
  // high-water mark is what avoids a 60s model reload between turns.
  await provider.complete({ system: "hi", messages: [], tools: [], model: "m" });

  assert.equal(bodies[1].options.num_ctx, bodies[0].options.num_ctx);
});

test("requests are streamed, so a slow model is not cut off by a wall-clock deadline", async () => {
  const bodies: any[] = [];
  mockOllama({ chunks: [{ message: { content: "ok" } }, { done: true }], onChat: (b) => bodies.push(b) });
  await new OllamaProvider({}).complete({ system: "s", messages: [], tools: [], model: "m" });
  assert.equal(bodies[0].stream, true);
});

test("a pinned context size overrides the automatic sizing", async () => {
  const bodies: any[] = [];
  mockOllama({ chunks: [{ message: { content: "ok" } }, { done: true }], onChat: (b) => bodies.push(b) });
  await new OllamaProvider({ contextTokens: 4096 }).complete({
    system: "s".repeat(50_000),
    messages: [],
    tools: [],
    model: "m",
  });
  assert.equal(bodies[0].options.num_ctx, 4096);
});
