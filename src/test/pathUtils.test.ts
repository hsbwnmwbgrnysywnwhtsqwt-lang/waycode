import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { safeResolve, toRelative } from "../tools/pathUtils";

const ROOT = path.resolve("/tmp/waycode-root");

test("safeResolve resolves a relative path inside the workspace", () => {
  assert.equal(safeResolve(ROOT, "a/b.txt"), path.join(ROOT, "a/b.txt"));
});

test("safeResolve allows the root itself", () => {
  assert.equal(safeResolve(ROOT, "."), ROOT);
});

test("safeResolve blocks parent-directory traversal", () => {
  assert.throws(() => safeResolve(ROOT, "../secret.txt"), /outside the workspace/);
});

test("safeResolve blocks absolute paths outside the workspace", () => {
  assert.throws(() => safeResolve(ROOT, "/etc/passwd"), /outside the workspace/);
});

test("safeResolve allows an absolute path inside the workspace", () => {
  const inside = path.join(ROOT, "src/index.ts");
  assert.equal(safeResolve(ROOT, inside), inside);
});

test("toRelative returns a workspace-relative path", () => {
  assert.equal(toRelative(ROOT, path.join(ROOT, "src/a.ts")), path.join("src", "a.ts"));
});
