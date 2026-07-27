import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  FindFilesTool,
  FileDeleteTool,
  FileMoveTool,
  FileEditTool,
  FileReadTool,
  globToRegExp,
} from "../tools/FileTools";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ToolContext, ToolPreview } from "../tools/Tool";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "waycode-tools-"));
}

function ctx(root: string, approve = true): ToolContext & { previews: ToolPreview[] } {
  const previews: ToolPreview[] = [];
  return {
    workspaceRoot: root,
    previews,
    async requestApproval(p) {
      previews.push(p);
      return approve;
    },
    log() {},
  };
}

test("glob patterns translate with the standard * / ** meanings", () => {
  assert.ok(globToRegExp("**/*.html").test("a/b/index.html"));
  assert.ok(globToRegExp("**/*.html").test("index.html"), "**/ must also match zero directories");
  assert.ok(!globToRegExp("*.html").test("a/index.html"), "* must not cross a separator");
  assert.ok(globToRegExp("src/**/*.ts").test("src/ui/deep/App.ts"));
  assert.ok(globToRegExp("index.html").test("index.html"));
  assert.ok(globToRegExp("inde?.html").test("index.html"));
  // A dot in the pattern is literal, not "any character".
  assert.ok(!globToRegExp("a.html").test("axhtml"));
});

test("find_files locates a file by name anywhere in the tree", async () => {
  const dir = await tmp();
  try {
    // The exact failure this tool exists for: the agent could not find a page
    // sitting in the project because nothing searched by NAME.
    await fs.mkdir(path.join(dir, "src/pages"), { recursive: true });
    await fs.writeFile(path.join(dir, "index.html"), "x");
    await fs.writeFile(path.join(dir, "src/pages/about.html"), "x");
    await fs.writeFile(path.join(dir, "src/app.ts"), "x");

    const tool = new FindFilesTool();
    const html = await tool.run({ pattern: "**/*.html" }, ctx(dir));
    assert.match(html.output, /index\.html/);
    assert.match(html.output, /about\.html/);
    assert.doesNotMatch(html.output, /app\.ts/);

    const one = await tool.run({ pattern: "index.html" }, ctx(dir));
    assert.match(one.output, /index\.html/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("find_files skips node_modules and reports honestly when nothing matches", async () => {
  const dir = await tmp();
  try {
    await fs.mkdir(path.join(dir, "node_modules/pkg"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules/pkg/index.html"), "x");
    const res = await new FindFilesTool().run({ pattern: "**/*.html" }, ctx(dir));
    assert.match(res.output, /No files match/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("edit_file can rename every occurrence when asked", async () => {
  const dir = await tmp();
  try {
    const f = path.join(dir, "a.js");
    await fs.writeFile(f, "let count=1;\ncount++;\nreturn count;\n");
    const tool = new FileEditTool();

    // Without replace_all a repeated snippet is refused — and now says how to proceed.
    const refused = await tool.run({ path: "a.js", old_text: "count", new_text: "total" }, ctx(dir));
    assert.equal(refused.isError, true);
    assert.match(refused.output, /replace_all/);

    const done = await tool.run(
      { path: "a.js", old_text: "count", new_text: "total", replace_all: true },
      ctx(dir)
    );
    assert.equal(done.isError, undefined);
    const after = await fs.readFile(f, "utf8");
    assert.equal(after, "let total=1;\ntotal++;\nreturn total;\n");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("replace_all treats old_text literally, not as a regex", async () => {
  const dir = await tmp();
  try {
    const f = path.join(dir, "a.js");
    await fs.writeFile(f, "a.b(1); a.b(2);");
    await new FileEditTool().run(
      { path: "a.js", old_text: "a.b(", new_text: "c.d(", replace_all: true },
      ctx(dir)
    );
    assert.equal(await fs.readFile(f, "utf8"), "c.d(1); c.d(2);");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("read_file can page through a large file instead of dumping it", async () => {
  const dir = await tmp();
  try {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    await fs.writeFile(path.join(dir, "big.txt"), lines);
    const tool = new FileReadTool();

    const page = await tool.run({ path: "big.txt", offset: 100, limit: 5 }, ctx(dir));
    assert.match(page.output, /lines 100-104 of 500/);
    assert.match(page.output, /100\tline 100/);
    assert.doesNotMatch(page.output, /line 106/);
    assert.match(page.output, /more lines \(read from 105\)/);

    // No range given → unchanged behaviour, the whole file.
    const whole = await tool.run({ path: "big.txt" }, ctx(dir));
    assert.equal(whole.output, lines);

    const past = await tool.run({ path: "big.txt", offset: 9999 }, ctx(dir));
    assert.equal(past.isError, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("delete_file always asks, and honours a refusal", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "A");
    const refused = ctx(dir, false);
    const no = await new FileDeleteTool().run({ path: "a.txt" }, refused);
    assert.equal(no.isError, true);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "A");
    // Deletion has no undo, so it must never be silently auto-approved.
    assert.equal(refused.previews[0].destructive, true);

    const yes = await new FileDeleteTool().run({ path: "a.txt" }, ctx(dir));
    assert.equal(yes.isError, undefined);
    await assert.rejects(() => fs.readFile(path.join(dir, "a.txt")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("move_file renames and leaves nothing behind", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "old.txt"), "content");
    const res = await new FileMoveTool().run({ path: "old.txt", dest: "new/name.txt" }, ctx(dir));
    assert.equal(res.isError, undefined);
    assert.equal(await fs.readFile(path.join(dir, "new/name.txt"), "utf8"), "content");
    await assert.rejects(() => fs.readFile(path.join(dir, "old.txt")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("none of the new tools can escape the workspace", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "A");
    await assert.rejects(() => new FileDeleteTool().run({ path: "../a.txt" }, ctx(dir)), /outside|workspace/i);
    await assert.rejects(
      () => new FileMoveTool().run({ path: "a.txt", dest: "../out.txt" }, ctx(dir)),
      /outside|workspace/i
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the names models guess for the new tools all resolve", () => {
  const reg = ToolRegistry.default();
  const expected: Record<string, string> = {
    glob: "find_files",
    find_file: "find_files",
    locate: "find_files",
    rm: "delete_file",
    remove_file: "delete_file",
    move: "move_file",
    rename: "move_file",
    rename_file: "move_file",
    cp: "copy_file",
    copy: "copy_file",
  };
  for (const [alias, real] of Object.entries(expected)) {
    assert.equal(reg.get(alias)?.name, real, alias);
  }
});

test("plan mode still exposes only read-only tools", () => {
  const names = ToolRegistry.default()
    .readOnlySchemas()
    .map((s) => s.name);
  assert.ok(names.includes("find_files"), "finding files is read-only and must stay available");
  for (const write of ["delete_file", "move_file", "copy_file", "edit_file", "write_file"]) {
    assert.ok(!names.includes(write), `${write} must not be offered in plan mode`);
  }
});
