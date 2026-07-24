import { test } from "node:test";
import assert from "node:assert/strict";
import { trimHistory } from "../agent/history";
import { ChatMessage } from "../providers/types";

const user = (n: number): ChatMessage => ({ role: "user", content: `u${n}` });
const asst = (n: number): ChatMessage => ({ role: "assistant", content: `a${n}`, toolCalls: [] });
const tool = (n: number): ChatMessage => ({ role: "tool", toolResults: [{ callId: `${n}`, content: "r" }] });

test("history under the cap is returned unchanged", () => {
  const h = [user(1), asst(1), tool(1)];
  assert.equal(trimHistory(h, 40), h);
});

test("trimming keeps the tail and starts at a user message", () => {
  // Build 10 turns of [user, assistant, tool] = 30 messages.
  const h: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) h.push(user(i), asst(i), tool(i));
  const trimmed = trimHistory(h, 12);
  assert.ok(trimmed.length <= 12);
  assert.equal(trimmed[0].role, "user", "first sent message must be a user turn");
  // The most recent turn is preserved.
  assert.deepEqual(trimmed[trimmed.length - 1], h[h.length - 1]);
});

test("trimming never splits a user/assistant/tool cycle", () => {
  const h: ChatMessage[] = [];
  for (let i = 0; i < 8; i++) h.push(user(i), asst(i), tool(i));
  const trimmed = trimHistory(h, 10);
  // Every 'tool' message must be preceded (somewhere earlier) by an assistant,
  // and the sequence must begin at a user boundary.
  assert.equal(trimmed[0].role, "user");
  // Count should be a whole number of 3-message cycles from a user boundary.
  assert.equal(trimmed.length % 3, 0);
});
