import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDiff } from "../tools/diff";

test("makeDiff marks changed lines with + and -", () => {
  const out = makeDiff("a\nb\nc", "a\nx\nc", "file.txt");
  assert.ok(out.includes("--- file.txt"));
  assert.ok(out.includes("+++ file.txt"));
  assert.ok(out.includes("- b"), "removed line b");
  assert.ok(out.includes("+ x"), "added line x");
  assert.ok(out.includes("  a"), "context line a");
  assert.ok(out.includes("  c"), "context line c");
});

test("makeDiff on identical content has no +/- lines", () => {
  const out = makeDiff("same\ntext", "same\ntext", "f");
  const changed = out
    .split("\n")
    .filter((l) => l.startsWith("+ ") || l.startsWith("- "));
  assert.equal(changed.length, 0);
});

test("makeDiff handles pure additions", () => {
  const out = makeDiff("", "new line", "f");
  assert.ok(out.includes("+ new line"));
});

test("makeDiff handles pure deletions", () => {
  const out = makeDiff("old line", "", "f");
  assert.ok(out.includes("- old line"));
});
