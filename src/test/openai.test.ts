import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "../providers/OpenAIProvider";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("OpenAI maps roles/tool_calls in the request and parses tool calls back", async () => {
  let body: any;
  globalThis.fetch = (async (_url: string, opts: any) => {
    body = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "lookup", arguments: '{"x":1}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    };
  }) as unknown as typeof fetch;

  const provider = new OpenAIProvider({ apiKey: "k" });
  const res = await provider.complete({
    system: "SYS",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "f", input: { a: 1 } }] },
      { role: "tool", toolResults: [{ callId: "t1", content: "res" }] },
    ],
    tools: [{ name: "f", description: "d", parameters: { type: "object", properties: {} } }],
    model: "gpt-4o",
  });

  // Request shape
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "SYS");
  assert.equal(body.messages[1].content, "hi");
  assert.ok(Array.isArray(body.messages[2].tool_calls));
  assert.equal(body.messages[2].tool_calls[0].function.name, "f");
  assert.equal(body.messages[3].role, "tool");
  assert.equal(body.messages[3].tool_call_id, "t1");

  // Response parsing
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, "lookup");
  assert.equal(res.toolCalls[0].input.x, 1);
  assert.equal(res.stopReason, "tool_use");
});

test("OpenAI honours a custom baseUrl", async () => {
  let calledUrl = "";
  globalThis.fetch = (async (url: string) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }) };
  }) as unknown as typeof fetch;

  const provider = new OpenAIProvider({ apiKey: "k", baseUrl: "http://localhost:1234/v1" });
  await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], model: "m" });
  assert.equal(calledUrl, "http://localhost:1234/v1/chat/completions");
});

test("a tool-free call omits `tools` entirely — an empty array is a 400", async () => {
  // This is the communicator role's request shape: pure text, no tools.
  let body: any;
  globalThis.fetch = (async (_url: string, opts: any) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }) };
  }) as unknown as typeof fetch;

  const provider = new OpenAIProvider({ apiKey: "k" });
  await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], model: "m" });

  assert.ok(!("tools" in body), "tools must be absent, not []");
  assert.ok(!("tool_choice" in body), "tool_choice is meaningless without tools");
});
