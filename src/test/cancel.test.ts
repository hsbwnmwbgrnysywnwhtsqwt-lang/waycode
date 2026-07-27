import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Agent, AgentEvents } from "../agent/Agent";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { AIProvider, CompletionRequest, CompletionResponse } from "../providers/types";

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

const POLICY = {
  autoApproveReads: true,
  autoApproveWrites: true,
  autoApproveCommands: true,
  planMode: false,
};

function agentIn(dir: string, provider: AIProvider, maxSteps = 4): Agent {
  return new Agent(
    provider,
    ToolRegistry.default(),
    new ProjectContext(dir),
    fakeMemory(),
    { model: "m", maxSteps, language: "auto", policy: POLICY },
    dir
  );
}

test("cancelling mid-turn still answers EVERY tool call, so the next turn is valid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-cancel-"));
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "A", "utf8");
    await fs.writeFile(path.join(dir, "b.txt"), "B", "utf8");

    const calls: CompletionRequest[] = [];
    let step = 0;
    const provider: AIProvider = {
      id: "p",
      label: "p",
      requiresApiKey: false,
      async complete(req): Promise<CompletionResponse> {
        calls.push(req);
        step++;
        if (step === 1) {
          return {
            text: "",
            toolCalls: [
              { id: "t1", name: "read_file", input: { path: "a.txt" } },
              { id: "t2", name: "read_file", input: { path: "b.txt" } },
            ],
            stopReason: "tool_use",
          };
        }
        return { text: "ok", toolCalls: [], stopReason: "end" };
      },
    };

    const agent = agentIn(dir, provider);
    // Stop the run the moment the first tool finishes — the second never runs.
    await agent.run(
      "read both files",
      noopEvents({ onToolEnd: () => agent.cancel() })
    );

    // The next turn must carry a tool_result for BOTH tool_use blocks, or the
    // provider rejects the whole conversation.
    await agent.run("continue", noopEvents());
    const next = calls[calls.length - 1];
    const toolTurn = next.messages.find((m) => m.role === "tool");
    assert.ok(toolTurn, "the cancelled turn's tool results must still be in history");
    const ids = (toolTurn!.toolResults ?? []).map((r) => r.callId);
    assert.deepEqual(ids, ["t1", "t2"]);
    const skipped = toolTurn!.toolResults!.find((r) => r.callId === "t2")!;
    assert.match(skipped.content, /cancelled/i);
    assert.equal(skipped.isError, true);

    // Every assistant tool_use has a matching result — the invariant that broke.
    for (const m of next.messages) {
      if (m.role !== "assistant" || !m.toolCalls?.length) continue;
      const results = next.messages
        .filter((x) => x.role === "tool")
        .flatMap((x) => x.toolResults ?? [])
        .map((r) => r.callId);
      for (const c of m.toolCalls) {
        assert.ok(results.includes(c.id), `tool_use ${c.id} has no tool_result`);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("running out of steps says so instead of stopping silently", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-steps-"));
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "A", "utf8");
    const provider: AIProvider = {
      id: "p",
      label: "p",
      requiresApiKey: false,
      async complete(): Promise<CompletionResponse> {
        // Never finishes — always asks for one more tool call.
        return {
          text: "",
          toolCalls: [{ id: `t${Math.random()}`, name: "read_file", input: { path: "a.txt" } }],
          stopReason: "tool_use",
        };
      },
    };

    const logs: string[] = [];
    await agentIn(dir, provider, 2).run("go", noopEvents({ onLog: (m) => logs.push(m) }));
    assert.ok(
      logs.some((l) => /maximum of 2 steps/.test(l)),
      `expected a step-budget warning, got: ${logs.join(" | ")}`
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a finished turn is not reported as having run out of steps", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-steps-"));
  try {
    const provider: AIProvider = {
      id: "p",
      label: "p",
      requiresApiKey: false,
      async complete(): Promise<CompletionResponse> {
        return { text: "All done — I changed nothing.", toolCalls: [], stopReason: "end" };
      },
    };
    const logs: string[] = [];
    await agentIn(dir, provider, 2).run("go", noopEvents({ onLog: (m) => logs.push(m) }));
    assert.ok(!logs.some((l) => /maximum of/.test(l)), logs.join(" | "));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
