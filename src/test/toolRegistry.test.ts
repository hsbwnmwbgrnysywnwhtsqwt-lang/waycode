import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../tools/ToolRegistry";

const reg = ToolRegistry.default();

test("resolves exact tool names", () => {
  assert.equal(reg.get("run_terminal")?.name, "run_terminal");
  assert.equal(reg.get("edit_file")?.name, "edit_file");
});

test("resolves common aliases models guess", () => {
  assert.equal(reg.get("run_command")?.name, "run_terminal");
  assert.equal(reg.get("bash")?.name, "run_terminal");
  assert.equal(reg.get("str_replace")?.name, "edit_file");
  assert.equal(reg.get("grep")?.name, "search_code");
  assert.equal(reg.get("ls")?.name, "list_files");
  assert.equal(reg.get("test")?.name, "run_tests");
});

test("returns undefined for a truly unknown tool", () => {
  assert.equal(reg.get("frobnicate"), undefined);
});

test("readOnlySchemas excludes write and execute tools", () => {
  const names = reg.readOnlySchemas().map((s) => s.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("search_code"));
  assert.ok(!names.includes("edit_file"));
  assert.ok(!names.includes("run_terminal"));
});
