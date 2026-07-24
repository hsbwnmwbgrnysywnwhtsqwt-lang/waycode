import { AIProvider } from "../providers/types";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { Agent, AgentConfig, AgentEvents } from "./Agent";
import {
  buildCommunicatorInPrompt,
  buildCommunicatorOutPrompt,
} from "./prompts";
import { classifyRoute } from "./routing";

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
  }

  async run(userMessage: string, events: AgentEvents): Promise<void> {
    try {
      const summary = await this.project.summarize();

      // ---- Phase 1: communicator understands the user and ROUTES -----------
      events.onPhase?.("communicator-in", "🗣️ Language bot is reading your message…");
      const routeResponse = await this.communicator.provider.complete({
        system: buildCommunicatorInPrompt(summary, this.config.language),
        messages: [{ role: "user", content: userMessage }],
        tools: [],
        model: this.communicator.model,
        temperature: 0.2,
        maxTokens: 1200,
      });
      const route = classifyRoute(routeResponse.text, userMessage);

      // CHAT: the language bot answers directly — no coder involved.
      if (route.kind === "chat") {
        events.onPhase?.("route-chat", "🧭 Handled directly (conversation)");
        events.onAssistantText(route.content || "🙂");
        events.onDone();
        return;
      }

      // CODE: hand a precise spec to the coder.
      events.onPhase?.("route-code", "🧭 Routing to the coder bot");
      const spec = route.content;
      events.onLog(`📋 Task spec:\n${spec}`);

      // ---- Phase 2: coder does the engineering -----------------------------
      events.onPhase?.("coder", "👨‍💻 Coder bot is working on the code…");
      const coderEvents = this.wrapForCoder(events);
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
      const coderSummary = await this.currentCoder.run(spec, coderEvents);

      // ---- Phase 3: communicator explains the result -----------------------
      events.onPhase?.("communicator-out", "🗣️ Language bot is preparing the explanation…");
      const explainResponse = await this.communicator.provider.complete({
        system: buildCommunicatorOutPrompt(this.config.language),
        messages: [
          {
            role: "user",
            content:
              `The user's original request was:\n${userMessage}\n\n` +
              `The coding agent reported:\n${coderSummary || "(the coder produced no summary; it may have failed — explain honestly)"}`,
          },
        ],
        tools: [],
        model: this.communicator.model,
        temperature: 0.3,
        maxTokens: 1500,
      });
      events.onAssistantText(explainResponse.text.trim() || coderSummary || "Done.");
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
  private wrapForCoder(events: AgentEvents): AgentEvents {
    return {
      onAssistantText: (t) => events.onThinking(`👨‍💻 ${t}`),
      onThinking: (t) => events.onThinking(t),
      onToolStart: (c) => events.onToolStart(c),
      onToolEnd: (c, r, p) => events.onToolEnd(c, r, p),
      onLog: (m) => events.onLog(m),
      requestApproval: (p) => events.requestApproval(p),
      onError: (m) => events.onError(m),
      onDone: () => {
        /* controlled by the orchestrator */
      },
    };
  }
}
