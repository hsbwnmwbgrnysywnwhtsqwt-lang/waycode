import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { buildSearchCommand, GrepTool } from "../tools/SearchTools";

test("buildSearchCommand uses grep -E so the fallback supports alternation", () => {
  const cmd = buildSearchCommand("(Gemini|GEMINI_API_KEY)", undefined, false);
  assert.match(cmd, /grep -rnE/, "grep fallback must use extended regex");
  assert.match(cmd, /^rg /, "ripgrep is tried first");
  assert.match(cmd, /-i /, "case-insensitive by default");
});

test("buildSearchCommand omits -i when case-sensitive", () => {
  const cmd = buildSearchCommand("Foo", undefined, true);
  assert.doesNotMatch(cmd, / -i /);
});

test("search_code actually finds an alternation pattern in files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-search-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "import { GeminiProvider } from './gemini';");
    const res = await new GrepTool().run(
      { pattern: "(Gemini|Foobar)" },
      { workspaceRoot: dir, requestApproval: async () => true, log: () => undefined }
    );
    assert.match(res.output, /GeminiProvider/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
