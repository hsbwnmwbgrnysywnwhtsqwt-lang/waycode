import { AIProvider, ChatMessage, ToolCall } from "../providers/types";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { Agent, AgentConfig, AgentEvents } from "./Agent";
import {
  buildCommunicatorInPrompt,
  buildCommunicatorOutPrompt,
} from "./prompts";
import { classifyRoute } from "./routing";
import { trimHistory } from "./history";

export interface RoleModel {
  provider: AIProvider;
  model: string;
}

/**
 * Multi-agent pipeline:
 *
 *   user (Hebrew/any language)
 *     → communicator bot  (understands, produces an English task spec)
 *     → coder bot          (writes/edits code, runs & fixes via tools)
 *     → verify (lint/tests, done inside the coder's own loop)
 *     → communicator bot   (explains the result in the user's language)
 *
 * Each role can run on a different provider/model, so the language-strong model
 * talks to the user while a code-strong model (that need not speak the language)
 * does the engineering.
 */
export class Orchestrator {
  private currentCoder?: Agent;
  /**
   * The user-facing conversation with the COMMUNICATOR (what the user typed and
   * what they were actually shown), persisted across turns so it has memory.
   * The router's internal CHAT:/CODE: protocol text and the coder's ground-truth
   * blob are never stored here — only the real exchange, kept clean for context.
   */
  private history: ChatMessage[] = [];

  constructor(
    private readonly communicator: RoleModel,
    private readonly coder: RoleModel,
    private readonly tools: ToolRegistry,
    private readonly project: ProjectContext,
    private readonly memory: Memory,
    private readonly config: AgentConfig,
    private readonly workspaceRoot: string
  ) {}

  cancel(): void {
    this.currentCoder?.cancel();
  }

  reset(): void {
    this.currentCoder?.reset();
    this.history = [];
  }

  async run(userMessage: string, events: AgentEvents): Promise<void> {
    try {
      const summary = await this.project.summarize();
      // Conversation so far, BEFORE this turn — reused by both communicator calls.
      const priorHistory = trimHistory(this.history);

      // ---- Phase 1: communicator understands the user and ROUTES -----------
      events.onPhase?.("communicator-in", "🗣️ Language bot is reading your message…");
      const routeResponse = await this.communicator.provider.complete({
        system: buildCommunicatorInPrompt(summary, this.config.language),
        messages: [...priorHistory, { role: "user", content: userMessage }],
        tools: [],
        model: this.communicator.model,
        temperature: 0.2,
        maxTokens: 1200,
      });
      const route = classifyRoute(routeResponse.text, userMessage);

      // CHAT: the language bot answers directly — no coder involved.
      if (route.kind === "chat") {
        events.onPhase?.("route-chat", "🧭 Handled directly (conversation)");
        const answer = route.content || "🙂";
        events.onAssistantText(answer);
        this.history.push({ role: "user", content: userMessage }, { role: "assistant", content: answer });
        events.onDone();
        return;
      }

      // CODE: hand a precise spec to the coder.
      events.onPhase?.("route-code", "🧭 Routing to the coder bot");
      const spec = route.content;
      events.onLog(`📋 Task spec:\n${spec}`);

      // ---- Phase 2: coder does the engineering -----------------------------
      events.onPhase?.("coder", "👨‍💻 Coder bot is working on the code…");
      // Record the coder's ACTUAL tool actions — the ground truth we give the
      // communicator so it cannot fabricate changes that never happened.
      const actions: string[] = [];
      const coderEvents = this.wrapForCoder(events, actions);
      // Reuse one coder across turns so follow-up requests keep prior context.
      if (!this.currentCoder) {
        this.currentCoder = new Agent(
          this.coder.provider,
          this.tools,
          this.project,
          this.memory,
          { ...this.config, model: this.coder.model },
          this.workspaceRoot
        );
      }
      let coderSummary = await this.currentCoder.run(spec, coderEvents);

      // If the coder stalled (produced a plan but ran no tools), nudge it once
      // to actually act instead of asking the user to confirm.
      if (actions.length === 0) {
        events.onLog("↻ Coder ran no tools — nudging it to act.");
        coderSummary = await this.currentCoder.run(
          "You did not use any tools, so nothing was done. Do the task NOW by calling the tools (search/read/edit/create/run). Do not ask for confirmation and do not just describe a plan.",
          coderEvents
        );
      }

      // ---- Phase 3: communicator explains the result -----------------------
      events.onPhase?.("communicator-out", "🗣️ Language bot is preparing the explanation…");
      const changed = actions.some((a) => a.startsWith("changed:"));
      const verified = actions.some((a) => a.startsWith("ran:"));
      const groundTruth = actions.length
        ? actions.join("\n")
        : "(NO tools were run and NO changes were made.)";
      const explainResponse = await this.communicator.provider.complete({
        system: buildCommunicatorOutPrompt(this.config.language),
        messages: [
          ...priorHistory,
          {
            role: "user",
            content:
              `The user's original request was:\n${userMessage}\n\n` +
              `GROUND TRUTH — tools the coder actually ran and their results:\n${groundTruth}\n\n` +
              `Files were ${changed ? "" : "NOT "}modified. A build/test/lint was ${
                verified ? "" : "NOT "
              }run — ${verified ? "" : "so do NOT claim the project builds or tests pass."}\n\n` +
              `The coder's own notes (may be optimistic — trust the ground truth over this):\n${
                coderSummary || "(none)"
              }`,
          },
        ],
        tools: [],
        model: this.communicator.model,
        temperature: 0.2,
        maxTokens: 1500,
      });
      const explanation = explainResponse.text.trim() || coderSummary || "Done.";
      events.onAssistantText(explanation);
      // Only the real exchange enters history — not the internal spec/ground-truth.
      this.history.push({ role: "user", content: userMessage }, { role: "assistant", content: explanation });
      events.onDone();
    } catch (err) {
      events.onError(err instanceof Error ? err.message : String(err));
      events.onDone();
    }
  }

  /**
   * The coder's own assistant text is intermediate (often in English), so route
   * it to the "thinking" channel; the user-facing answer comes from the
   * communicator. Swallow the coder's onDone so the pipeline controls completion.
   */
  private wrapForCoder(events: AgentEvents, actions: string[]): AgentEvents {
    return {
      onAssistantText: (t) => events.onThinking(`👨‍💻 ${t}`),
      onThinking: (t) => events.onThinking(t),
      onToolStart: (c) => events.onToolStart(c),
      onToolEnd: (c, r, p) => {
        // Record the ground-truth action with a truthful prefix.
        let prefix = "read";
        if (WRITE_TOOLS.has(c.name)) prefix = r.isError ? "attempted-change" : "changed";
        else if (COMMAND_TOOLS.has(c.name)) prefix = "ran";
        const status = r.isError ? `ERROR: ${oneLine(r.content)}` : "ok";
        actions.push(`${prefix}: ${c.name} ${summarizeCall(c)} → ${status}`);
        events.onToolEnd(c, r, p);
      },
      onLog: (m) => events.onLog(m),
      requestApproval: (p) => events.requestApproval(p),
      onError: (m) => events.onError(m),
      onDone: () => {
        /* controlled by the orchestrator */
      },
    };
  }
}

const WRITE_TOOLS = new Set(["create_file", "write_file", "edit_file"]);
const COMMAND_TOOLS = new Set(["run_terminal", "run_tests", "run_linter", "git"]);

/** A short human-readable summary of what a tool call targeted. */
function summarizeCall(c: ToolCall): string {
  const i = (c.input || {}) as Record<string, unknown>;
  if (i.command) return String(i.command);
  if (i.args) return `git ${i.args}`;
  if (i.path) return String(i.path);
  if (i.pattern) return `/${i.pattern}/`;
  return "";
}

function oneLine(s: string): string {
  return (s || "").replace(/\s+/g, " ").slice(0, 200);
}
