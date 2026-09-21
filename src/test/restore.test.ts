import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Agent, AgentEvents } from "../agent/Agent";
import { Orchestrator } from "../agent/Orchestrator";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { AIProvider, CompletionRequest, CompletionResponse } from "../providers/types";

function scripted(id: string, replies: string[]): { provider: AIProvider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let i = 0;
  return {
    calls,
    provider: {
      id,
      label: id,
      requiresApiKey: false,
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        calls.push(req);
        const text = replies[Math.min(i, replies.length - 1)];
        i++;
        return { text, toolCalls: [], stopReason: "end" };
      },
    },
  };
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

const POLICY = {
  autoApproveReads: true,
  autoApproveWrites: true,
  autoApproveCommands: true,
  planMode: false,
};

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "waycode-restore-"));
}

test("a restored conversation is replayed into the agent's context", async () => {
  const dir = await tmp();
  try {
    const model = scripted("m", ["Sure."]);
    const agent = new Agent(
      model.provider,
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      { model: "m", maxSteps: 2, language: "auto", policy: POLICY },
      dir
    );

    agent.restore([
      { role: "user", content: "call the project Mihmish" },
      { role: "assistant", content: "Got it — the project is called Mihmish." },
    ]);
    await agent.run("what is the project called?", noopEvents());

    const sent = model.calls[0].messages.map((m) => m.content ?? "").join("\n");
    assert.match(sent, /call the project Mihmish/);
    assert.match(sent, /the project is called Mihmish/);
    assert.match(sent, /what is the project called\?/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the conversation context file is injected into the agent's system prompt", async () => {
  const dir = await tmp();
  try {
    const model = scripted("m", ["ok"]);
    const agent = new Agent(
      model.provider,
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      { model: "m", maxSteps: 2, language: "auto", policy: POLICY },
      dir
    );

    agent.setSessionContext("# Conversation context so far\n## Turn 1\nchanged: create_file README.md");
    await agent.run("continue", noopEvents());

    assert.match(model.calls[0].system, /create_file README\.md/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reset clears both the replayed history and the conversation context", async () => {
  const dir = await tmp();
  try {
    const model = scripted("m", ["ok"]);
    const agent = new Agent(
      model.provider,
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      { model: "m", maxSteps: 2, language: "auto", policy: POLICY },
      dir
    );

    agent.restore([{ role: "user", content: "old thread" }]);
    agent.setSessionContext("# old context");
    agent.reset();
    await agent.run("fresh", noopEvents());

    const sent = model.calls[0].messages.map((m) => m.content ?? "").join("\n");
    assert.doesNotMatch(sent, /old thread/);
    assert.doesNotMatch(model.calls[0].system, /old context/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("restoring a conversation reaches BOTH roles of the multi-agent pipeline", async () => {
  const dir = await tmp();
  try {
    const comm = scripted("comm", ["CODE: Goal: continue the work.", "explained"]);
    const coder = scripted("coder", ["done"]);
    const orch = new Orchestrator(
      { provider: comm.provider, model: "c" },
      { provider: coder.provider, model: "d" },
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      { model: "d", maxSteps: 2, language: "auto", policy: POLICY },
      dir
    );

    orch.restore([
      { role: "user", content: "build the Mihmish tools page" },
      { role: "assistant", content: "I created README.md." },
    ]);
    orch.setSessionContext("# Conversation context so far\nchanged: create_file README.md → ok");
    await orch.run("now add index.html", noopEvents());

    // The communicator sees the earlier exchange…
    const routerMsgs = comm.calls[0].messages.map((m) => m.content ?? "").join("\n");
    assert.match(routerMsgs, /build the Mihmish tools page/);
    assert.match(comm.calls[0].system, /create_file README\.md/);

    // …and so does the coder, which is built lazily on the first CODE turn.
    const coderMsgs = coder.calls[0].messages.map((m) => m.content ?? "").join("\n");
    assert.match(coderMsgs, /build the Mihmish tools page/);
    assert.match(coder.calls[0].system, /create_file README\.md/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the coder is asked to finish deliverables it never touched", async () => {
  const dir = await tmp();
  try {
    const comm = scripted("comm", [
      "CODE: Goal: docs and page.\nDeliverables: README.md\nindex.html",
      "explained",
    ]);
    const coder = scripted("coder", ["I created the README."]);
    const orch = new Orchestrator(
      { provider: comm.provider, model: "c" },
      { provider: coder.provider, model: "d" },
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      { model: "d", maxSteps: 2, language: "auto", policy: POLICY },
      dir
    );

    const logs: string[] = [];
    await orch.run("write a README and a landing page", noopEvents({ onLog: (m) => logs.push(m) }));

    // The coder never called a tool, so it is told both files are outstanding.
    const followUps = coder.calls
      .flatMap((c) => c.messages.map((m) => m.content ?? ""))
      .join("\n");
    assert.match(followUps, /never created or edited: README\.md, index\.html/);
    assert.ok(logs.some((l) => l.includes("Deliverables not touched yet")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a new task does not leak the previous conversation into a coder built later", async () => {
  const dir = await tmp();
  try {
    const comm = scripted("comm", ["CODE: Goal: make a fresh file.", "explained"]);
    const coder = scripted("coder", ["done"]);
    const orch = new Orchestrator(
      { provider: comm.provider, model: "c" },
      { provider: coder.provider, model: "d" },
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      { model: "d", maxSteps: 2, language: "auto", policy: POLICY },
      dir
    );

    // A thread the user then closes with "New task" — the coder was never built
    // during it (every turn was CHAT), so the backlog was still pending.
    orch.restore([
      { role: "user", content: "SECRET earlier thread about payroll" },
      { role: "assistant", content: "I edited payroll.ts." },
    ]);
    orch.reset();

    await orch.run("create notes.md", noopEvents());

    const coderSaw = coder.calls.flatMap((c) => c.messages.map((m) => m.content ?? "")).join("\n");
    assert.doesNotMatch(coderSaw, /SECRET earlier thread/);
    assert.doesNotMatch(coderSaw, /payroll\.ts/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a chat-only turn still reaches the coder, so the roles share one conversation", async () => {
  const dir = await tmp();
  try {
    // Turn 1 is CODE (which creates the coder), turn 2 is CHAT, turn 3 is CODE.
    const comm = scripted("comm", [
      "CODE: Goal: make a card.",
      "explained",
      "CHAT: Sure — I'll call it Test instead.",
      "CODE: Goal: rename it.",
      "explained again",
    ]);
    const coder = scripted("coder", ["done"]);
    const orch = new Orchestrator(
      { provider: comm.provider, model: "c" },
      { provider: coder.provider, model: "d" },
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      { model: "d", maxSteps: 2, language: "auto", policy: POLICY },
      dir
    );

    await orch.run("add a card", noopEvents());
    await orch.run("actually call it Test", noopEvents());
    await orch.run("now rename it", noopEvents());

    // The coder's LAST request must carry both the chat turn it never ran for
    // and the plain-language version of what the user originally asked.
    const seenByCoder = coder.calls
      .flatMap((c) => c.messages.map((m) => m.content ?? ""))
      .join("\n");
    assert.match(seenByCoder, /actually call it Test/);
    assert.match(seenByCoder, /I'll call it Test instead/);
    assert.match(seenByCoder, /the user's own words/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the coder is instructed in English even when the user replies in Hebrew", async () => {
  const dir = await tmp();
  try {
    const comm = scripted("comm", ["CODE: Goal: remove a card.", "הוסבר"]);
    const coder = scripted("coder", ["done"]);
    const orch = new Orchestrator(
      { provider: comm.provider, model: "c" },
      { provider: coder.provider, model: "d" },
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      // The user wants Hebrew replies…
      { model: "d", maxSteps: 2, language: "Hebrew", policy: POLICY },
      dir
    );

    await orch.run("תמחק את הכרטיס", noopEvents());

    // …the communicator obeys that, but the coder must be told English.
    assert.match(comm.calls[0].system, /reply to the user in Hebrew/i);
    assert.match(coder.calls[0].system, /reply to the user in English/i);
    assert.doesNotMatch(coder.calls[0].system, /reply to the user in Hebrew/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
