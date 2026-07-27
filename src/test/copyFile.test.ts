import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { FileCopyTool } from "../tools/FileTools";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ToolContext, ToolPreview } from "../tools/Tool";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "waycode-copy-"));
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

test("a copy is byte-for-byte, not regenerated", async () => {
  const dir = await tmp();
  try {
    // The real failure: a 495-line page came back as a 284-byte placeholder
    // because the model was re-creating it instead of copying.
    const original = "<!DOCTYPE html>\n" + "<div>line</div>\n".repeat(500);
    await fs.writeFile(path.join(dir, "index.html"), original, "utf8");

    const res = await new FileCopyTool().run(
      { path: "index.html", dest: "indxxx.html" },
      ctx(dir)
    );

    assert.equal(res.isError, undefined);
    const copy = await fs.readFile(path.join(dir, "indxxx.html"), "utf8");
    assert.equal(copy, original, "the copy must be identical to the original");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("copying onto an existing file is refused unless overwrite is asked for", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "A", "utf8");
    await fs.writeFile(path.join(dir, "b.txt"), "B", "utf8");
    const tool = new FileCopyTool();

    const blocked = await tool.run({ path: "a.txt", dest: "b.txt" }, ctx(dir));
    assert.equal(blocked.isError, true);
    assert.match(blocked.output, /already exists/);
    assert.equal(await fs.readFile(path.join(dir, "b.txt"), "utf8"), "B");

    const c = ctx(dir);
    const forced = await tool.run({ path: "a.txt", dest: "b.txt", overwrite: true }, c);
    assert.equal(forced.isError, undefined);
    assert.equal(await fs.readFile(path.join(dir, "b.txt"), "utf8"), "A");
    // Replacing existing content must always reach the user, whatever the policy.
    assert.equal(c.previews[0].destructive, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a rejected copy writes nothing", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "A", "utf8");
    const res = await new FileCopyTool().run({ path: "a.txt", dest: "c.txt" }, ctx(dir, false));
    assert.equal(res.isError, true);
    await assert.rejects(() => fs.readFile(path.join(dir, "c.txt")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("copying into a subdirectory creates it", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "A", "utf8");
    const res = await new FileCopyTool().run({ path: "a.txt", dest: "backup/deep/a.txt" }, ctx(dir));
    assert.equal(res.isError, undefined);
    assert.equal(await fs.readFile(path.join(dir, "backup/deep/a.txt"), "utf8"), "A");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a copy cannot escape the workspace", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "A", "utf8");
    await assert.rejects(
      () => new FileCopyTool().run({ path: "a.txt", dest: "../escaped.txt" }, ctx(dir)),
      /outside|workspace/i
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("missing source and same-file copies are reported, not attempted", async () => {
  const dir = await tmp();
  try {
    const tool = new FileCopyTool();
    const missing = await tool.run({ path: "nope.txt", dest: "x.txt" }, ctx(dir));
    assert.equal(missing.isError, true);
    assert.match(missing.output, /does not exist/);

    await fs.writeFile(path.join(dir, "a.txt"), "A", "utf8");
    const same = await tool.run({ path: "a.txt", dest: "a.txt" }, ctx(dir));
    assert.equal(same.isError, true);
    assert.match(same.output, /same file/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the names models guess for copying all resolve to copy_file", () => {
  const reg = ToolRegistry.default();
  assert.equal(reg.get("copy_file")?.name, "copy_file");
  for (const alias of ["cp", "copy", "duplicate_file"]) {
    assert.equal(reg.get(alias)?.name, "copy_file", alias);
  }
  // `mv` and `rename_file` mean MOVE — they must not silently leave the original
  // behind now that move_file exists.
  for (const alias of ["mv", "rename_file", "rename", "move"]) {
    assert.equal(reg.get(alias)?.name, "move_file", alias);
  }
});
