/**
 * Regression tests for the "announced the edit, never made it" incident: asked
 * to add a project card to index.html and projects.html, the coder ran one
 * search, said "I will add the WayCode project card to both index.html and
 * projects.html", and ended the task. Nothing was written, twice in a row.
 *
 * Two separate defects let that through, one covered by each half of this file:
 *  - the stall nudge was gated on the run having used no tool yet, so the
 *    harmless search bought the model an early exit, and
 *  - the phrase list only matched "I will NOW ..." so a bare "I will add ..."
 *    read as a finished answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Agent, looksLikeStall } from "../agent/Agent";
import { AIProvider, CompletionResponse } from "../providers/types";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";

test("bare future intent to act is a stall, in English and in Hebrew", () => {
  // Verbatim from the transcript — neither line contains "now".
  assert.equal(
    looksLikeStall(
      "I will add the WayCode project card to both `index.html` and `projects.html`, inside the section."
    ),
    true
  );
  assert.equal(
    looksLikeStall("I will search for the relevant sections in both `index.html` and `projects.html`."),
    true
  );
  assert.equal(looksLikeStall("I'll create the file next."), true);
  assert.equal(looksLikeStall("Let me read the config first."), true);
  assert.equal(looksLikeStall("עכשיו אחפש את הקטע הרלוונטי בקובץ"), true);
  assert.equal(looksLikeStall("אני אוסיף את הכרטיס לשני הקבצים"), true);
});

test("a finished answer is not mistaken for a stall", () => {
  // Past tense: work reported, not promised.
  assert.equal(looksLikeStall("I added the card to both files and ran the tests — 14 pass."), false);
  assert.equal(looksLikeStall("I searched for the grid but found no matching section."), false);
  // Future tense, but explaining rather than acting.
  assert.equal(looksLikeStall("Let me explain how the approval flow works."), false);
  assert.equal(looksLikeStall("I will describe the two options so you can choose."), false);
  assert.equal(looksLikeStall("The answer is 42."), false);
});

/** A provider that replays a fixed script of turns, one per step. */
function scriptedProvider(turns: CompletionResponse[]): AIProvider {
  let turn = 0;
  return {
    id: "p",
    label: "p",
    requiresApiKey: false,
    async complete() {
      return turns[turn++] ?? { text: "done", toolCalls: [], stopReason: "end" as const };
    },
  };
}

test("a read followed by an announced edit is nudged, and the edit lands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-stall-"));
  try {
    await fs.writeFile(path.join(dir, "index.html"), "<div class='projects-grid'></div>", "utf8");

    // Exactly the shape of the failing transcript, plus the turn the nudge buys.
    const provider = scriptedProvider([
      {
        text: "I will search for the relevant sections.",
        toolCalls: [{ id: "1", name: "search_code", input: { pattern: "projects-grid" } }],
        stopReason: "tool_use",
      },
      {
        text: "I will add the WayCode project card to both `index.html` and `projects.html`.",
        toolCalls: [],
        stopReason: "end",
      },
      {
        text: "",
        toolCalls: [{ id: "2", name: "create_file", input: { path: "card.html", content: "<div>WayCode</div>" } }],
        stopReason: "tool_use",
      },
      { text: "Created card.html.", toolCalls: [], stopReason: "end" },
    ]);

    const logs: string[] = [];
    const agent = new Agent(
      provider,
      ToolRegistry.default(),
      new ProjectContext(dir),
      new Memory({ get: () => undefined, update: async () => undefined } as any),
      {
        model: "m",
        maxSteps: 10,
        language: "auto",
        policy: { autoApproveReads: true, autoApproveWrites: true, autoApproveCommands: true, planMode: false },
      },
      dir
    );

    await agent.run("add the card", {
      onAssistantText() {},
      onThinking() {},
      onToolStart() {},
      onToolEnd() {},
      onLog: (m) => logs.push(m),
      async requestApproval() {
        return true;
      },
      onError() {},
      onDone() {},
    });

    assert.ok(
      logs.some((l) => l.includes("nudging")),
      "the announced-but-unmade edit should have been nudged"
    );
    assert.equal(
      await fs.readFile(path.join(dir, "card.html"), "utf8"),
      "<div>WayCode</div>",
      "the file the model promised must actually be written"
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("plan mode is never nudged — announcing changes is the whole point there", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-plan-"));
  try {
    const provider = scriptedProvider([
      { text: "I will add a card to index.html once you approve.", toolCalls: [], stopReason: "end" },
    ]);
    const logs: string[] = [];
    const agent = new Agent(
      provider,
      ToolRegistry.default(),
      new ProjectContext(dir),
      new Memory({ get: () => undefined, update: async () => undefined } as any),
      {
        model: "m",
        maxSteps: 10,
        language: "auto",
        policy: { autoApproveReads: true, autoApproveWrites: false, autoApproveCommands: false, planMode: true },
      },
      dir
    );

    await agent.run("what would you change?", {
      onAssistantText() {},
      onThinking() {},
      onToolStart() {},
      onToolEnd() {},
      onLog: (m) => logs.push(m),
      async requestApproval() {
        return true;
      },
      onError() {},
      onDone() {},
    });

    assert.ok(!logs.some((l) => l.includes("nudging")), "a plan is the deliverable in plan mode");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
