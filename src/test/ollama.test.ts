import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../providers/OllamaProvider";
import { CompletionRequest } from "../providers/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Make the provider's next call return this Ollama `message` object. */
function mockMessage(message: unknown): void {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ message, prompt_eval_count: 1, eval_count: 1 }),
  })) as unknown as typeof fetch;
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

test("builds an Ollama request with a system message and mapped roles", async () => {
  let captured: any;
  globalThis.fetch = (async (_url: string, opts: any) => {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ message: { content: "ok" } }) };
  }) as unknown as typeof fetch;

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
