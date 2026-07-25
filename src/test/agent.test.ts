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

test("plan mode hides write tools from the model and refuses changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waycode-plan-"));
  try {
    let firstReq: CompletionRequest | undefined;
    let calls = 0;
    const provider: AIProvider = {
      id: "p",
      label: "p",
      requiresApiKey: false,
      async complete(req) {
        calls++;
        if (calls === 1) {
          firstReq = req;
          return {
            text: "",
            toolCalls: [{ id: "1", name: "create_file", input: { path: "x.txt", content: "hi" } }],
            stopReason: "tool_use",
          };
        }
        return { text: "here is my plan", toolCalls: [], stopReason: "end" };
      },
    };

    const agent = new Agent(
      provider,
      ToolRegistry.default(),
      new ProjectContext(dir),
      fakeMemory(),
      {
        model: "m",
        maxSteps: 3,
        language: "auto",
        policy: {
          autoApproveReads: true,
          autoApproveWrites: true,
          autoApproveCommands: true,
          planMode: true,
        },
      },
      dir
    );

    let toolOutput = "";
    await agent.run("create x.txt", noopEvents({ onToolEnd: (_c, r) => (toolOutput = r.content) }));

    // The model was offered only read-only tools.
    const toolNames = (firstReq?.tools ?? []).map((t) => t.name);
    assert.ok(toolNames.includes("read_file"));
    assert.ok(!toolNames.includes("create_file"), "write tools must be hidden in plan mode");
    // Even if it calls a write tool, it is refused...
    assert.match(toolOutput, /Plan mode is on/);
    // ...and no file is created.
    await assert.rejects(() => fs.access(path.join(dir, "x.txt")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
