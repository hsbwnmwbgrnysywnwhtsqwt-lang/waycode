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
import { trimHistory } from "./history";

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

/**
 * Live, mutable run policy. The UI can flip these between turns (moon toggle,
 * plan mode) WITHOUT rebuilding the agent, because the agent reads them fresh on
 * every step from this shared object.
 */
export interface RunPolicy {
  /** Auto-approve read-only tools (read/list/search). */
  autoApproveReads: boolean;
  /** Auto-approve file writes/edits/creates. */
  autoApproveWrites: boolean;
  /** Auto-approve terminal/git/test/lint commands. */
  autoApproveCommands: boolean;
  /** Plan mode: investigate read-only and propose a plan; make no changes. */
  planMode: boolean;
}

export interface AgentConfig {
  model: string;
  maxSteps: number;
  /** Reply language: "auto" (match the user) or a language name like "Hebrew". */
  language: string;
  /** Shared, mutable policy read live on each step. */
  policy: RunPolicy;
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
    let inputTokens = 0;
    let outputTokens = 0;
    const summary = await this.project.summarize();

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

        // Read plan mode live so a mid-conversation toggle takes effect at once.
        const planMode = this.config.policy.planMode;
        const system = buildSystemPrompt(summary, this.memory.render(), this.config.language, planMode);
        const toolSchemas = planMode ? this.tools.readOnlySchemas() : this.tools.schemas();

        const response = await this.provider.complete({
          system,
          messages: trimHistory(this.history),
          tools: toolSchemas,
          model: this.config.model,
          maxTokens: 4096,
          temperature: 0,
        });

        inputTokens += response.usage?.inputTokens ?? 0;
        outputTokens += response.usage?.outputTokens ?? 0;

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
      if (inputTokens || outputTokens) {
        events.onLog(`📊 Tokens — ${inputTokens} in / ${outputTokens} out`);
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
    // In plan mode, refuse any change — investigate and propose a plan instead.
    if (this.config.policy.planMode && tool.risk !== "read") {
      return {
        output: `Plan mode is on — '${tool.name}' is disabled. Do not make changes; describe this step in your plan for the user to approve.`,
        isError: true,
      };
    }
    // Skip the approval prompt when this risk category is auto-approved.
    const p = this.config.policy;
    const autoApproved =
      (tool.risk === "read" && p.autoApproveReads) ||
      (tool.risk === "write" && p.autoApproveWrites) ||
      (tool.risk === "execute" && p.autoApproveCommands);
    const wrappedCtx: ToolContext = autoApproved
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
