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

    // The coder was nudged repeatedly (both the Agent's own in-loop stall
    // detection and the orchestrator's post-run nudge) but never called a tool.
    assert.ok(coder.calls.length > 1, "the coder should have been nudged at least once");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the communicator remembers prior turns across separate run() calls", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-orch-"));
  try {
    const comm = scripted("comm", ["CHAT: Nice to meet you, Dana!", "CHAT: Your name is Dana."]);
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
        policy: { autoApproveReads: true, autoApproveWrites: true, autoApproveCommands: true, planMode: false },
      },
      dir
    );

    await orch.run("Hi, I'm Dana", noopEvents());
    let answer2 = "";
    await orch.run("What's my name?", noopEvents({ onAssistantText: (t) => (answer2 = t) }));

    assert.equal(answer2, "Your name is Dana.");
    // The second router call must include the first exchange as prior context.
    const secondCall = comm.calls[1];
    const joined = secondCall.messages.map((m) => m.content ?? "").join("\n");
    assert.match(joined, /Hi, I'm Dana/);
    assert.match(joined, /Nice to meet you, Dana!/);
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

test("a coder whose provider fails is not nudged twice more with the same error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-orch-"));
  try {
    const comm = scripted("comm", [
      "CODE: Goal: write docs.\nDeliverables: README.md",
      "explained",
    ]);
    let coderCalls = 0;
    const coder: AIProvider = {
      id: "coder",
      label: "coder",
      requiresApiKey: false,
      async complete(): Promise<CompletionResponse> {
        coderCalls++;
        throw new Error("Ollama error 500: model not found");
      },
    };

    const orch = new Orchestrator(
      { provider: comm.provider, model: "c" },
      { provider: coder, model: "d" },
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      {
        model: "d",
        maxSteps: 4,
        language: "auto",
        policy: { autoApproveReads: true, autoApproveWrites: true, autoApproveCommands: true, planMode: false },
      },
      dir
    );

    const errors: string[] = [];
    await orch.run("write a README", noopEvents({ onError: (m) => errors.push(m) }));

    assert.equal(coderCalls, 1, "the failing coder must be called once, not re-nudged");
    assert.equal(errors.length, 1, `the user should see one error, saw ${errors.length}`);

    // And the explanation must be told the task failed rather than reporting success.
    const explain = comm.calls[1].messages.map((m) => m.content ?? "").join("\n");
    assert.match(explain, /coder FAILED/);
    assert.match(explain, /model not found/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Stop actually stops the pipeline instead of restarting the coder", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-orch-"));
  try {
    const comm = scripted("comm", [
      "CODE: Goal: docs.\nDeliverables: README.md",
      "explained",
    ]);
    let coderCalls = 0;
    const orch: Orchestrator = new Orchestrator(
      { provider: comm.provider, model: "c" },
      {
        provider: {
          id: "coder",
          label: "coder",
          requiresApiKey: false,
          async complete(): Promise<CompletionResponse> {
            coderCalls++;
            // The user hits Stop while the coder is thinking.
            orch.cancel();
            return { text: "I will create the README.", toolCalls: [], stopReason: "end" };
          },
        },
        model: "d",
      },
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      {
        model: "d",
        maxSteps: 4,
        language: "auto",
        policy: { autoApproveReads: true, autoApproveWrites: true, autoApproveCommands: true, planMode: false },
      },
      dir
    );

    const logs: string[] = [];
    let answered = "";
    await orch.run("write a README", noopEvents({
      onLog: (m) => logs.push(m),
      onAssistantText: (t) => (answered = t),
    }));

    assert.equal(coderCalls, 1, "a cancelled coder must not be nudged back to work");
    assert.ok(logs.some((l) => l.includes("Cancelled by user")), logs.join(" | "));
    assert.equal(answered, "", "a cancelled turn produces no invented summary");
    assert.equal(comm.calls.length, 1, "no explanation round-trip after a cancel");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
