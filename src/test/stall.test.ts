import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Agent, AgentEvents } from "../agent/Agent";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { AIProvider, CompletionRequest } from "../providers/types";

function fakeMemory(): Memory {
  return new Memory({ get: () => undefined, update: async () => undefined } as any);
}

function noopEvents(overrides: Partial<AgentEvents> = {}): AgentEvents {
  return {
    onAssistantText() {},
    onThinking() {},
    onToolStart() {},
    onToolEnd() {},
    onLog() {},
    async requestApproval() {
      return true;
    },
    onError() {},
    onDone() {},
    onPhase() {},
    ...overrides,
  };
}

test("a stalled plan (no tool call) is nudged and the model then acts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-stall-"));
  try {
    let calls = 0;
    const requests: CompletionRequest[] = [];
    const provider: AIProvider = {
      id: "p",
      label: "p",
      requiresApiKey: false,
      async complete(req) {
        // trimHistory returns the live array by reference when no trimming is
        // needed, so snapshot the messages now — they would otherwise appear
        // mutated by later turns when inspected after the run completes.
        requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
        calls++;
        if (calls === 1) {
          return {
            text: "Here is my plan: 1. search 2. edit. Let's start by searching.",
            toolCalls: [],
            stopReason: "end",
          };
        }
        if (calls === 2) {
          return {
            text: "",
            toolCalls: [{ id: "1", name: "search_code", input: { pattern: "x" } }],
            stopReason: "tool_use",
          };
        }
        return { text: "Done — found nothing to change.", toolCalls: [], stopReason: "end" };
      },
    };

    const agent = new Agent(
      provider,
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      {
        model: "m",
        maxSteps: 5,
        language: "auto",
        policy: { autoApproveReads: true, autoApproveWrites: true, autoApproveCommands: true, planMode: false },
      },
      dir
    );

    let nudged = false;
    await agent.run("do something", noopEvents({ onLog: (m) => { if (m.includes("nudging")) nudged = true; } }));

    assert.equal(calls, 3, "nudge -> tool call -> final answer");
    assert.ok(nudged, "a nudge log should have been emitted");
    // The nudge was injected as a user turn asking the model to act.
    const secondReq = requests[1];
    const lastMsg = secondReq.messages[secondReq.messages.length - 1];
    assert.equal(lastMsg.role, "user");
    assert.match(lastMsg.content ?? "", /CALL THE TOOL/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a genuine final answer with no stall phrasing is NOT nudged", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-stall2-"));
  try {
    let calls = 0;
    const provider: AIProvider = {
      id: "p",
      label: "p",
      requiresApiKey: false,
      async complete() {
        calls++;
        return { text: "The answer is 42.", toolCalls: [], stopReason: "end" };
      },
    };
    const agent = new Agent(
      provider,
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      {
        model: "m",
        maxSteps: 5,
        language: "auto",
        policy: { autoApproveReads: true, autoApproveWrites: true, autoApproveCommands: true, planMode: false },
      },
      dir
    );
    await agent.run("what is the answer?", noopEvents());
    assert.equal(calls, 1, "a direct final answer should not trigger a retry");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
