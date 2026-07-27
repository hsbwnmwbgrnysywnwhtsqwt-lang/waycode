import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { SessionNotes, countTurns, stripHeader, trimToTail, NOTES_HEADER } from "../memory/SessionNotes";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "waycode-notes-"));
}

test("a fresh conversation renders no context block", async () => {
  const dir = await tmp();
  try {
    const notes = new SessionNotes(dir, "s1");
    assert.equal(await notes.render(), "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("turns are appended to the conversation's own file and render for the prompt", async () => {
  const dir = await tmp();
  try {
    const notes = new SessionNotes(dir, "s1");
    await notes.appendTurn({
      request: "create a README for the project",
      actions: ["changed: create_file README.md → ok"],
      result: "Created README.md.",
    });
    await notes.appendTurn({
      request: "now the landing page too",
      actions: ["changed: create_file index.html → ok", "ran: run_tests npm test → ok"],
      result: "Created index.html and the tests pass.",
    });

    const rendered = await notes.render();
    assert.match(rendered, /Turn 1/);
    assert.match(rendered, /Turn 2/);
    assert.match(rendered, /create_file README\.md/);
    assert.match(rendered, /create_file index\.html/);

    // It is a real file on disk, so it outlives the extension host.
    const onDisk = await fs.readFile(path.join(dir, "s1.md"), "utf8");
    assert.match(onDisk, /create_file README\.md/);

    // A second reader of the same conversation sees the same context.
    const reopened = new SessionNotes(dir, "s1");
    assert.match(await reopened.render(), /create_file README\.md/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a turn with no tool calls is recorded as 'nothing was changed'", async () => {
  const dir = await tmp();
  try {
    const notes = new SessionNotes(dir, "s2");
    await notes.appendTurn({ request: "hello", actions: [], result: "Hi!" });
    assert.match(await notes.render(), /none — nothing was changed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("each conversation gets its own context file", async () => {
  const dir = await tmp();
  try {
    const a = new SessionNotes(dir, "conv-a");
    const b = new SessionNotes(dir, "conv-b");
    await a.appendTurn({ request: "task A", actions: [], result: "done A" });
    await b.appendTurn({ request: "task B", actions: [], result: "done B" });

    assert.match(await a.render(), /task A/);
    assert.doesNotMatch(await a.render(), /task B/);
    assert.notEqual(a.filePath(), b.filePath());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("trimming drops the oldest turns and keeps the most recent ones", () => {
  const turns = Array.from(
    { length: 20 },
    (_, i) => `\n## Turn ${i + 1} — 2026-07-26 10:00\n**User asked:** ${"x".repeat(200)}\n`
  ).join("");
  const trimmed = trimToTail(NOTES_HEADER + turns, 1200);

  assert.ok(trimmed.length <= 1400, "stays near the cap");
  assert.match(trimmed, /## Turn 20/, "keeps the newest turn");
  assert.doesNotMatch(trimmed, /## Turn 1 —/, "drops the oldest turn");
  assert.match(trimmed, /older turns trimmed/);
});

test("a file under the cap is left untouched", () => {
  const md = NOTES_HEADER + "\n## Turn 1 — 2026-07-26 10:00\n**User asked:** hi\n";
  assert.equal(trimToTail(md, 12_000), md);
  assert.equal(countTurns(md), 1);
  assert.match(stripHeader(md), /^## Turn 1/);
});

test("turn numbers keep counting up after old turns are trimmed away", async () => {
  const dir = await tmp();
  try {
    const notes = new SessionNotes(dir, "s3");
    // Enough turns, each big enough, that trimming has to drop the oldest.
    for (let i = 0; i < 30; i++) {
      await notes.appendTurn({
        request: `request ${i} ` + "x".repeat(500),
        actions: [`changed: create_file f${i}.ts → ok`],
        result: "y".repeat(500),
      });
    }
    const md = await fs.readFile(path.join(dir, "s3.md"), "utf8");
    const numbers = [...md.matchAll(/^## Turn (\d+)/gm)].map((m) => Number(m[1]));

    assert.ok(numbers.length > 1, "several turns survive the trim");
    assert.equal(new Set(numbers).size, numbers.length, `duplicate turn numbers: ${numbers}`);
    assert.equal(numbers[numbers.length - 1], 30, "the newest turn is still numbered 30");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
