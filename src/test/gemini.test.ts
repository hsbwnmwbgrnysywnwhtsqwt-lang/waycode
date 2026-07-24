import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "../providers/GeminiProvider";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("Gemini builds systemInstruction/contents/tools and parses functionCall", async () => {
  let body: any;
  let url = "";
  globalThis.fetch = (async (u: string, opts: any) => {
    url = u;
    body = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: "hi " }, { functionCall: { name: "lookup", args: { x: 1 } } }] } },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }),
    };
  }) as unknown as typeof fetch;

  const provider = new GeminiProvider({ apiKey: "KEY" });
  const res = await provider.complete({
    system: "SYS",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "f", input: { a: 1 } }] },
      { role: "tool", toolResults: [{ callId: "t1", content: "res" }] },
    ],
    tools: [{ name: "f", description: "d", parameters: { type: "object", properties: {} } }],
    model: "gemini-2.0-flash",
  });

  // Request shape
  assert.equal(body.systemInstruction.parts[0].text, "SYS");
  assert.equal(body.contents[0].role, "user");
  assert.equal(body.contents[1].role, "model");
  assert.equal(body.tools[0].functionDeclarations[0].name, "f");
  assert.ok(url.includes("gemini-2.0-flash"));
  assert.ok(url.includes("KEY"));

  // Response parsing
  assert.equal(res.text, "hi ");
  assert.equal(res.toolCalls[0].name, "lookup");
  assert.equal(res.toolCalls[0].input.x, 1);
  assert.equal(res.stopReason, "tool_use");
});
