/**
 * Regression tests for the "speculative plan" incident: qwen2.5-coder answered
 * with a 10-step numbered plan carrying one JSON tool call per step. Every one
 * was recovered from the prose and executed — including `npm run dev` twice and
 * a `write_file` that replaced a 10 KB README with a four-line changelog.
 *
 * Each layer that should have stopped it is covered here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { OllamaProvider } from "../providers/OllamaProvider";
import { AIProvider, CompletionRequest, ToolSchema } from "../providers/types";
import { isDestructiveOverwrite, FileWriteTool } from "../tools/FileTools";
import { isLongRunning } from "../tools/CommandTools";
import { Agent, looksLikeStall } from "../agent/Agent";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { ToolContext, ToolPreview } from "../tools/Tool";

const provider = new OllamaProvider({ baseUrl: "http://localhost:11434" });

function schema(name: string): ToolSchema {
  return { name, description: name, parameters: { type: "object", properties: {} } };
}

const TOOLS = ["search_code", "read_file", "edit_file", "write_file", "run_terminal"].map(schema);

function reqWith(tools: ToolSchema[]): CompletionRequest {
  return { system: "s", messages: [{ role: "user", content: "go" }], tools, model: "qwen2.5-coder:7b" };
}

function mockContent(content: string): void {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ message: { role: "assistant", content } }),
  })) as unknown as typeof fetch;
}

/** Verbatim shape of the response that caused the incident. */
const PLAN_WITH_CALLS = `I apologize for that oversight. Let's proceed with the task now.

1. **Search for Gemini references**:
   {"name":"search_code","arguments":{"pattern":"gemini|Gemini"}}

2. **Read the relevant files**:
   {"name":"read_file","arguments":{"path":"./app/lib/ai/gemini-provider.ts"}}

3. **Edit the files to replace Gemini references with Ollama**:
   {"name":"edit_file","arguments":{"path":"./app/lib/ai/gemini-provider.ts","old_text":"g","new_text":"o"}}

6. **Run the project to verify changes**:
   {"name":"run_terminal","arguments":{"command":"npm run dev"}}

10. **Summarize changes and verification**:
   {"name":"write_file","arguments":{"path":"./README.md","content":"Updated AI provider to use Ollama."}}
`;

const realFetch = globalThis.fetch;

test("a narrated plan yields only its FIRST tool call, not the whole batch", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  mockContent(PLAN_WITH_CALLS);
  const res = await provider.complete(reqWith(TOOLS));
  assert.equal(res.toolCalls.length, 1, "the remaining 9 steps must not execute");
  assert.equal(res.toolCalls[0].name, "search_code");
});

test("prose JSON naming a tool that was never offered is text, not a call", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  mockContent('Here is the config: {"name": "deploy_to_prod", "arguments": {"env": "live"}}');
  const res = await provider.complete(reqWith(TOOLS));
  assert.equal(res.toolCalls.length, 0);
  assert.equal(res.stopReason, "end");
});

test("no tool calls are recovered when no tools were offered at all", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  mockContent('{"name":"write_file","arguments":{"path":"a.md","content":"x"}}');
  const res = await provider.complete(reqWith([]));
  assert.equal(res.toolCalls.length, 0);
});

test("multiple explicit <tool_call> tags are still honoured as a batch", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  mockContent(
    '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>' +
      '<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>'
  );
  const res = await provider.complete(reqWith(TOOLS));
  assert.equal(res.toolCalls.length, 2);
});

test("a numbered plan with no tool call reads as a stall in any language", () => {
  // The Hebrew plan from the transcript, which the English-only phrase list missed.
  const hebrewPlan =
    "כדי להחליף את המודל אצטרך לבצע את הצעדים הבאים:\n\n" +
    "1. **מציאת providera הנוכחי**\n2. **הסרת המפתחות**\n3. **החלפת providera**\n";
  assert.equal(looksLikeStall(hebrewPlan), true);
  assert.equal(looksLikeStall("The answer is 42."), false);
  assert.equal(looksLikeStall("I found two issues: 1. a typo 2. a missing await"), false);
});

test("dev servers and watchers are refused; one-shot checks are allowed", () => {
  for (const cmd of [
    "npm run dev",
    "npm start",
    "yarn dev",
    "pnpm run serve",
    "next dev",
    "vite preview",
    "nodemon index.js",
    "uvicorn main:app",
    "python -m http.server 8000",
    "docker compose up",
    "tsc --watch",
    "npm run build && npm run dev",
  ]) {
    assert.equal(isLongRunning(cmd), true, `${cmd} should be refused`);
  }
  for (const cmd of ["npm run build", "npm test", "tsc --noEmit", "npm ci", "docker compose up -d", "git status"]) {
    assert.equal(isLongRunning(cmd), false, `${cmd} should be allowed`);
  }
});

test("collapsing a large file into a few lines counts as destructive", () => {
  const readme = "# Project\n" + "documentation line\n".repeat(500);
  assert.equal(isDestructiveOverwrite(readme, "Updated the AI provider to Ollama."), true);
  // Normal rewrites and growth are not gated.
  assert.equal(isDestructiveOverwrite(readme, readme.replace("Project", "Renamed")), false);
  assert.equal(isDestructiveOverwrite(readme, readme + "\nmore"), false);
  assert.equal(isDestructiveOverwrite("", "brand new content"), false);
  assert.equal(isDestructiveOverwrite("tiny", "x"), false);
});

test("auto mode auto-approves an ordinary write but still asks for a destructive one", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-auto-"));
  try {
    const big = "# Project\n" + "documentation line\n".repeat(500);
    await fs.writeFile(path.join(dir, "README.md"), big, "utf8");
    await fs.writeFile(path.join(dir, "notes.md"), big, "utf8");

    // Turn 1 wipes README (destructive), turn 2 rewrites notes in full (not).
    const writes = [
      { path: "README.md", content: "Updated." },
      { path: "notes.md", content: big.replace("Project", "Renamed") },
    ];
    let turn = 0;
    const provider: AIProvider = {
      id: "p",
      label: "p",
      requiresApiKey: false,
      async complete() {
        const w = writes[turn++];
        if (!w) return { text: "done", toolCalls: [], stopReason: "end" as const };
        return {
          text: "",
          toolCalls: [{ id: String(turn), name: "write_file", input: w }],
          stopReason: "tool_use" as const,
        };
      },
    };

    const asked: string[] = [];
    const agent = new Agent(
      provider,
      ToolRegistry.default(),
      new ProjectContext(dir),
      new Memory({ get: () => undefined, update: async () => undefined } as any),
      {
        model: "m",
        maxSteps: 5,
        language: "auto",
        // 🌙 auto: writes and commands are auto-approved.
        policy: { autoApproveReads: true, autoApproveWrites: true, autoApproveCommands: true, planMode: false },
      },
      dir
    );

    await agent.run("go", {
      onAssistantText() {},
      onThinking() {},
      onToolStart() {},
      onToolEnd() {},
      onLog() {},
      async requestApproval(p) {
        asked.push(p.title);
        return false; // the user declines the destructive overwrite
      },
      onError() {},
      onDone() {},
    });

    assert.deepEqual(asked, ["Write README.md"], "only the destructive write should prompt");
    assert.equal(await fs.readFile(path.join(dir, "README.md"), "utf8"), big, "README survives");
    assert.match(await fs.readFile(path.join(dir, "notes.md"), "utf8"), /^# Renamed/, "notes.md was written");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a destructive write asks for approval and aborts when refused", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-write-"));
  try {
    const rel = "README.md";
    const original = "# Project\n" + "documentation line\n".repeat(500);
    await fs.writeFile(path.join(dir, rel), original, "utf8");

    const seen: ToolPreview[] = [];
    const ctx: ToolContext = {
      workspaceRoot: dir,
      async requestApproval(p) {
        seen.push(p);
        return false;
      },
      log() {},
    };
    const res = await new FileWriteTool().run({ path: rel, content: "Updated." }, ctx);

    assert.equal(res.isError, true);
    assert.equal(seen[0].destructive, true, "the preview must be flagged so auto mode still asks");
    assert.equal(await fs.readFile(path.join(dir, rel), "utf8"), original, "the file must be untouched");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
