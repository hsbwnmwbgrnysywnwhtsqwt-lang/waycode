import {
  AIProvider,
  ChatMessage,
  ToolCall,
  ToolResult,
} from "../providers/types";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ToolContext, ToolPreview } from "../tools/Tool";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { buildSystemPrompt } from "./prompts";

/** Events the agent emits so the UI can render progress in real time. */
export interface AgentEvents {
  onAssistantText(text: string): void;
  onThinking(text: string): void;
  onToolStart(call: ToolCall): void;
  onToolEnd(call: ToolCall, result: ToolResult, preview?: ToolPreview): void;
  onLog(message: string): void;
  /** Ask the user to approve a risky action. */
  requestApproval(preview: ToolPreview): Promise<boolean>;
  onError(message: string): void;
  onDone(): void;
  /** Optional: announce a pipeline phase (used by the multi-agent orchestrator). */
  onPhase?(name: string, label: string): void;
}

export interface AgentConfig {
  model: string;
  maxSteps: number;
  autoApproveReads: boolean;
}

/**
 * The Agent engine: a plan → act → verify → fix loop driven by tool-calling.
 * Provider-agnostic — it only depends on the {@link AIProvider} interface.
 */
export class Agent {
  /** Conversation history shared across turns for continuity. */
  private readonly history: ChatMessage[] = [];
  private cancelled = false;

  constructor(
    private readonly provider: AIProvider,
    private readonly tools: ToolRegistry,
    private readonly project: ProjectContext,
    private readonly memory: Memory,
    private readonly config: AgentConfig,
    private readonly workspaceRoot: string
  ) {}

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Run one user task to completion (multiple tool-use steps).
   * Returns the agent's final assistant text (used by the orchestrator).
   */
  async run(userMessage: string, events: AgentEvents): Promise<string> {
    this.cancelled = false;
    let finalText = "";
    const summary = await this.project.summarize();
    const system = buildSystemPrompt(summary, this.memory.render());

    this.history.push({ role: "user", content: userMessage });

    const toolCtx: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      requestApproval: (preview) => events.requestApproval(preview),
      log: (m) => events.onLog(m),
    };

    try {
      for (let step = 0; step < this.config.maxSteps; step++) {
        if (this.cancelled) {
          events.onLog("⏹️ Cancelled by user.");
          break;
        }

        const response = await this.provider.complete({
          system,
          messages: this.history,
          tools: this.tools.schemas(),
          model: this.config.model,
          maxTokens: 4096,
          temperature: 0,
        });

        if (response.text.trim()) {
          finalText = response.text;
          events.onAssistantText(response.text);
        }

        // Record the assistant turn (text + any tool calls).
        this.history.push({
          role: "assistant",
          content: response.text,
          toolCalls: response.toolCalls,
        });

        if (!response.toolCalls.length) {
          break; // Model produced a final answer.
        }

        // Execute each requested tool and collect results for the next turn.
        const results: ToolResult[] = [];
        for (const call of response.toolCalls) {
          if (this.cancelled) break;
          events.onToolStart(call);
          const result = await this.executeTool(call, toolCtx, events);
          results.push({ callId: call.id, content: result.output, isError: result.isError });
          events.onToolEnd(call, { callId: call.id, content: result.output, isError: result.isError }, result.preview);
        }

        this.history.push({ role: "tool", toolResults: results });
      }
      events.onDone();
    } catch (err) {
      events.onError(err instanceof Error ? err.message : String(err));
      events.onDone();
    }
    return finalText;
  }

  private async executeTool(
    call: ToolCall,
    ctx: ToolContext,
    events: AgentEvents
  ): Promise<{ output: string; isError?: boolean; preview?: ToolPreview }> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { output: `Unknown tool '${call.name}'.`, isError: true };
    }
    // Read-only tools can skip the approval prompt when configured to.
    const wrappedCtx: ToolContext =
      tool.risk === "read" && this.config.autoApproveReads
        ? { ...ctx, requestApproval: async () => true }
        : ctx;
    try {
      return await tool.run(call.input, wrappedCtx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      events.onLog(`⚠️ Tool ${call.name} failed: ${msg}`);
      return { output: `Tool error: ${msg}`, isError: true };
    }
  }

  /** Clear the running conversation (start a fresh task thread). */
  reset(): void {
    this.history.length = 0;
  }
}
