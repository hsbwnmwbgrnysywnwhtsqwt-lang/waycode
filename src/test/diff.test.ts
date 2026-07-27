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

test("a large file with a one-line edit previews as hunks, not the whole file", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 1500", "line 1500 CHANGED");

  const out = makeDiff(before, after, "big.txt");
  const lines = out.split("\n");

  assert.ok(out.includes("- line 1500"), "the change itself is shown");
  assert.ok(out.includes("+ line 1500 CHANGED"));
  assert.ok(out.includes("  line 1499"), "with surrounding context");
  assert.ok(lines.length < 40, `preview should be small, got ${lines.length} lines`);
  assert.match(out, /@@ \d+ unchanged lines @@/);
});

test("a huge rewrite produces a bounded preview quickly instead of hanging", () => {
  // 20k completely different lines on both sides: the old O(n·m) table was
  // 400,000,000 cells, which froze the extension host.
  const before = Array.from({ length: 20_000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 20_000 }, (_, i) => `new ${i}`).join("\n");

  const started = Date.now();
  const out = makeDiff(before, after, "huge.txt");
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000, `diff took ${elapsed}ms`);
  assert.ok(out.split("\n").length <= 610, "the preview must stay bounded");
  assert.match(out, /preview truncated/);
});

test("an unchanged large file still shows no +/- lines", () => {
  const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const out = makeDiff(text, text, "same.txt");
  const changed = out.split("\n").filter((l) => l.startsWith("+ ") || l.startsWith("- "));
  assert.equal(changed.length, 0);
});
