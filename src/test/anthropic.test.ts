import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../providers/AnthropicProvider";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("Anthropic maps to content blocks and parses text + tool_use", async () => {
  let body: any;
  globalThis.fetch = (async (_url: string, opts: any) => {
    body = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        content: [
          { type: "text", text: "hi " },
          { type: "tool_use", id: "tu1", name: "lookup", input: { x: 1 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    };
  }) as unknown as typeof fetch;

  const provider = new AnthropicProvider({ apiKey: "k" });
  const res = await provider.complete({
    system: "SYS",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "f", input: { a: 1 } }] },
      { role: "tool", toolResults: [{ callId: "t1", content: "res" }] },
    ],
    tools: [{ name: "f", description: "d", parameters: { type: "object", properties: {} } }],
    model: "claude-sonnet-4-5",
  });

  // Request shape
  assert.equal(body.system, "SYS");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "hi");
  assert.equal(body.messages[1].role, "assistant");
  assert.ok(Array.isArray(body.messages[1].content));
  assert.equal(body.messages[1].content[0].type, "tool_use");
  // A tool result turn becomes a user message carrying tool_result blocks.
  assert.equal(body.messages[2].role, "user");
  assert.equal(body.messages[2].content[0].type, "tool_result");
  assert.equal(body.messages[2].content[0].tool_use_id, "t1");
  // Tools use Anthropic's input_schema field.
  assert.ok(body.tools[0].input_schema);

  // Response parsing
  assert.equal(res.text, "hi ");
  assert.equal(res.toolCalls[0].name, "lookup");
  assert.equal(res.toolCalls[0].input.x, 1);
  assert.equal(res.stopReason, "tool_use");
  assert.equal(res.usage?.inputTokens, 5);
});
