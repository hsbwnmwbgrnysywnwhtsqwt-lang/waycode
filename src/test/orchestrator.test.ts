import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Orchestrator } from "../agent/Orchestrator";
import { AgentEvents } from "../agent/Agent";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { AIProvider, CompletionRequest, CompletionResponse } from "../providers/types";

/** A provider that returns queued responses and records every request. */
function scripted(id: string, replies: string[]): { provider: AIProvider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let i = 0;
  const provider: AIProvider = {
    id,
    label: id,
    requiresApiKey: false,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      calls.push(req);
      const text = replies[Math.min(i, replies.length - 1)];
      i++;
      return { text, toolCalls: [], stopReason: "end" };
    },
  };
  return { provider, calls };
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

function fakeMemory(): Memory {
  return new Memory({ get: () => undefined, update: async () => undefined } as any);
}

test("communicator is told NOTHING changed when the coder runs no tools", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-orch-"));
  try {
    // Communicator: route to CODE, then produce the explanation.
    const comm = scripted("comm", ["CODE: replace X with Y", "here is the explanation"]);
    // Coder: only ever emits a plan with no tool calls (a stall) — even on the nudge.
    const coder = scripted("coder", ["I will do it. Please confirm before I proceed."]);

    const orch = new Orchestrator(
      { provider: comm.provider, model: "c" },
      { provider: coder.provider, model: "d" },
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      {
        model: "d",
        maxSteps: 4,
        language: "auto",
        policy: {
          autoApproveReads: true,
          autoApproveWrites: true,
          autoApproveCommands: true,
          planMode: false,
        },
      },
      dir
    );

    let answer = "";
    await orch.run("replace gemini with gemma", noopEvents({ onAssistantText: (t) => (answer = t) }));

    // The 2nd communicator call is the explanation — it must carry ground truth.
    const explainReq = comm.calls[1];
    const groundTruth = explainReq.messages.map((m) => m.content ?? "").join("\n");
    assert.match(groundTruth, /NO tools were run/i);
    assert.match(groundTruth, /NOT modified/);
    assert.equal(answer, "here is the explanation");

    // The coder was nudged once, so it was invoked twice.
    assert.equal(coder.calls.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a CHAT route answers directly without invoking the coder", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-orch-"));
  try {
    const comm = scripted("comm", ["CHAT: שלום! איך אפשר לעזור?"]);
    const coder = scripted("coder", ["should never be called"]);

    const orch = new Orchestrator(
      { provider: comm.provider, model: "c" },
      { provider: coder.provider, model: "d" },
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      {
        model: "d",
        maxSteps: 4,
        language: "auto",
        policy: {
          autoApproveReads: true,
          autoApproveWrites: true,
          autoApproveCommands: true,
          planMode: false,
        },
      },
      dir
    );

    let answer = "";
    await orch.run("hi", noopEvents({ onAssistantText: (t) => (answer = t) }));

    assert.equal(answer, "שלום! איך אפשר לעזור?");
    assert.equal(coder.calls.length, 0, "coder must not run for a CHAT message");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
