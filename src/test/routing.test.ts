import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRoute } from "../agent/routing";

test("CODE: prefix routes to the coder with the spec", () => {
  const r = classifyRoute("CODE: Goal: add a hello route", "תוסיף ראוט");
  assert.equal(r.kind, "code");
  assert.equal(r.content, "Goal: add a hello route");
});

test("CHAT: prefix answers directly with the reply", () => {
  const r = classifyRoute("CHAT: שלום! איך אפשר לעזור?", "היי");
  assert.equal(r.kind, "chat");
  assert.equal(r.content, "שלום! איך אפשר לעזור?");
});

test("legacy NO_CODE_TASK prefix is treated as chat", () => {
  const r = classifyRoute("NO_CODE_TASK: this is just an explanation", "?מה זה");
  assert.equal(r.kind, "chat");
  assert.equal(r.content, "this is just an explanation");
});

test("prefix matching is case-insensitive and colon-optional", () => {
  const r = classifyRoute("code Goal: do the thing", "x");
  assert.equal(r.kind, "code");
  assert.equal(r.content, "Goal: do the thing");
});

test("empty router reply falls back to a code task from the raw request", () => {
  const r = classifyRoute("   ", "צור קובץ");
  assert.equal(r.kind, "code");
  assert.equal(r.content, "צור קובץ");
});

test("no prefix but non-empty text is treated as a conversational answer", () => {
  const r = classifyRoute("Sure, here is how routing works…", "explain routing");
  assert.equal(r.kind, "chat");
  assert.equal(r.content, "Sure, here is how routing works…");
});

test("CODE: with no spec body falls back to the user message", () => {
  const r = classifyRoute("CODE:", "fix the bug in app.ts");
  assert.equal(r.kind, "code");
  assert.equal(r.content, "fix the bug in app.ts");
});
