import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ProjectContext } from "../context/ProjectContext";

test("summarize captures the tree, languages, and manifests, ignoring node_modules", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-ctx-"));
  try {
    await fs.writeFile(path.join(dir, "package.json"), "{}");
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, "src", "index.ts"), "export const x = 1;");
    await fs.writeFile(path.join(dir, "app.py"), "print(1)");
    await fs.mkdir(path.join(dir, "node_modules"));
    await fs.writeFile(path.join(dir, "node_modules", "junk.js"), "// junk");

    const summary = await new ProjectContext(dir).summarize();

    assert.ok(summary.tree.includes("package.json"));
    assert.ok(summary.tree.includes("src/"));
    assert.ok(summary.tree.includes("src/index.ts"));
    assert.ok(!summary.tree.includes("node_modules"), "node_modules must be ignored");
    assert.ok(summary.detectedLanguages.includes("TypeScript"));
    assert.ok(summary.detectedLanguages.includes("Python"));
    assert.ok(summary.manifests.includes("package.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
