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
import { readContextFile } from "../context/contextFile";
import { editBlocksToToolCalls, parseEditBlocks } from "./editBlocks";

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
 * A past user/assistant exchange replayed into a runner. Structurally identical
 * to {@link import("../memory/History").SessionMessage}, declared here so the
 * agent core stays free of any `vscode` dependency.
 */
export interface RestoredMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The Agent engine: a plan → act → verify → fix loop driven by tool-calling.
 * Provider-agnostic — it only depends on the {@link AIProvider} interface.
 */
export class Agent {
  /** Conversation history shared across turns for continuity. */
  private history: ChatMessage[] = [];
  private cancelled = false;
  /** The conversation's context file, injected into every system prompt. */
  private sessionContext = "";
  /**
   * The file the model most recently read or wrote. Models routinely omit the
   * path above a SEARCH/REPLACE block when the turn has only touched one file,
   * so this is what those blocks fall back to.
   */
  private lastFileRead?: string;

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
   * Set the conversation's persistent context (the session context file). Read
   * fresh on every run, so a turn always sees what the previous turns recorded.
   */
  setSessionContext(text: string): void {
    this.sessionContext = text;
  }

  /**
   * Replay a saved conversation into the working history, so reopening a thread
   * from the history — or switching model mid-thread — does not start the model
   * from zero. Tool calls are not replayed (their results are in the context
   * file instead), which keeps the transcript valid for every provider.
   */
  restore(messages: RestoredMessage[]): void {
    this.history = messages
      .filter((m) => m.content?.trim())
      .map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * Record an exchange that happened WITHOUT this agent running — used by the
   * multi-agent pipeline so the coder's history stays in step with the
   * conversation the user actually had. Without it the coder never learns what
   * was said on chat-only turns, nor what the user was finally told, and the two
   * roles drift into remembering different conversations.
   */
  noteExchange(userText: string, assistantText: string): void {
    if (userText.trim()) this.history.push({ role: "user", content: userText });
    if (assistantText.trim()) this.history.push({ role: "assistant", content: assistantText });
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
    const contextFile = await readContextFile(this.workspaceRoot);
    const memoryBlock = [this.memory.render(), contextFile, this.sessionContext]
      .filter(Boolean)
      .join("\n\n");

    this.history.push({ role: "user", content: userMessage });

    const toolCtx: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      requestApproval: (preview) => events.requestApproval(preview),
      log: (m) => events.onLog(m),
    };

    let stallNudges = 0;
    const MAX_STALL_NUDGES = 2;

    try {
      for (let step = 0; step < this.config.maxSteps; step++) {
        if (this.cancelled) {
          events.onLog("⏹️ Cancelled by user.");
          break;
        }

        // Read plan mode live so a mid-conversation toggle takes effect at once.
        const planMode = this.config.policy.planMode;
        const system = buildSystemPrompt(summary, memoryBlock, this.config.language, planMode);
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

        // A model that could not produce a tool call for an edit may still have
        // written the edit as a SEARCH/REPLACE block. Recover those and run them
        // as ordinary tool calls — this is what keeps a weak local coder from
        // "reading the file and changing nothing". Skipped in plan mode, where
        // no change may happen at all.
        let toolCalls = response.toolCalls;
        if (!toolCalls.length && !planMode) {
          const blocks = parseEditBlocks(response.text);
          const recovered = editBlocksToToolCalls(blocks, this.lastFileRead);
          if (recovered.length) {
            events.onLog(
              `✎ Recovered ${recovered.length} SEARCH/REPLACE edit${recovered.length > 1 ? "s" : ""} from the reply — applying as file edits.`
            );
            toolCalls = recovered;
          } else if (blocks.length) {
            // Blocks were written but no path was ever named or read.
            events.onLog("⚠️ Found SEARCH/REPLACE blocks but no file to apply them to.");
          }
        }

        // Record the assistant turn (text + any tool calls).
        this.history.push({
          role: "assistant",
          content: response.text,
          toolCalls,
        });

        if (!toolCalls.length) {
          // The model announced a plan/next-step but never called a tool — a
          // stall our system prompt explicitly forbids. Nudge it to act instead
          // of ending the task with nothing done. Bounded so it can't loop
          // forever. Deliberately NOT gated on "has this run used a tool yet":
          // the commonest stall of all is searching, announcing the edit, and
          // stopping — the read must not buy the model an early exit.
          if (!planMode && stallNudges < MAX_STALL_NUDGES && looksLikeStall(response.text)) {
            stallNudges++;
            events.onLog(`↻ Announced an action but called no tool — nudging the model to act (${stallNudges}/${MAX_STALL_NUDGES}).`);
            this.history.push({
              role: "user",
              content:
                "You did not call any tool — nothing was done. Stop describing a plan and CALL THE TOOL(S) now, in this message.",
            });
            continue;
          }
          break; // Model produced a final answer.
        }

        // Execute each requested tool and collect results for the next turn.
        const results: ToolResult[] = [];
        for (const call of toolCalls) {
          if (this.cancelled) break;
          events.onToolStart(call);
          const targetPath = (call.input as Record<string, unknown>)?.path;
          if (typeof targetPath === "string" && targetPath) this.lastFileRead = targetPath;
          const result = await this.executeTool(call, toolCtx, events);
          results.push({ callId: call.id, content: result.output, isError: result.isError });
          events.onToolEnd(call, { callId: call.id, content: result.output, isError: result.isError }, result.preview);
        }
        // EVERY tool call must get a result back, even the ones a cancel skipped:
        // an assistant turn whose tool_use blocks have no matching tool_result is
        // rejected outright by the chat APIs, so a single Stop used to poison the
        // conversation and make every later message fail.
        for (const call of toolCalls.slice(results.length)) {
          results.push({
            callId: call.id,
            content: "Not run — the user cancelled the task before this tool executed.",
            isError: true,
          });
        }

        this.history.push({ role: "tool", toolResults: results });
      }
      if (!this.cancelled && this.history[this.history.length - 1]?.role === "tool") {
        // We left the loop with a tool result as the last thing that happened,
        // i.e. the step budget ran out mid-task. Say so — silently stopping
        // looks identical to "finished", and the user is left waiting for a
        // summary that is never coming.
        events.onLog(
          `⚠️ Stopped after the maximum of ${this.config.maxSteps} steps without finishing. Send "continue" to carry on, or raise waycode.maxAgentSteps.`
        );
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
    // Skip the approval prompt when this risk category is auto-approved — except
    // for calls the tool itself flags as destructive (throwing away existing
    // work). Those always reach the user, however permissive the policy is.
    const p = this.config.policy;
    const autoApproved =
      (tool.risk === "read" && p.autoApproveReads) ||
      (tool.risk === "write" && p.autoApproveWrites) ||
      (tool.risk === "execute" && p.autoApproveCommands);
    const wrappedCtx: ToolContext = autoApproved
      ? {
          ...ctx,
          requestApproval: (preview) =>
            preview.destructive ? ctx.requestApproval(preview) : Promise.resolve(true),
        }
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
    this.history = [];
    this.sessionContext = "";
    this.lastFileRead = undefined;
  }
}

/**
 * Detects the specific anti-pattern our system prompt forbids: announcing a
 * plan / next step without calling a tool, instead of just acting. Kept narrow
 * so a genuine, complete conversational answer is never mistaken for a stall —
 * and it only ever runs when the turn made no tool call at all.
 *
 * Three independent signals, because no single one covers the real transcripts:
 *  - an explicit "asking permission" / "about to start" phrase,
 *  - bare first-person future intent to perform a tool-shaped action
 *    ("I will add the card to index.html"), in English or Hebrew, or
 *  - a multi-step numbered plan, which is language-independent.
 */
export function looksLikeStall(text: string): boolean {
  if (!text.trim()) return false;
  if (STALL_PHRASES.test(text)) return true;
  if (INTENT_TO_ACT.test(text) || HEBREW_INTENT_TO_ACT.test(text)) return true;
  return countNumberedSteps(text) >= 3;
}

/** Handing the turn back to the user instead of doing the work. */
const STALL_PHRASES =
  /\b(let'?s start|i will now|i'll now|let me start|going to start|please confirm|let me know if|would you like me to|shall i|should i proceed|here is my plan|here's my plan)\b/i;

/**
 * Verbs that map onto something a tool actually does. They keep the intent
 * patterns honest: "let me explain how this works" is a real answer, while
 * "let me edit the file" is a stall.
 */
const ACTION_VERB =
  "add|append|apply|change|check|create|delete|edit|fix|implement|insert|inspect|install|look|modify|move|open|read|refactor|remove|rename|replace|run|search|update|write";

/**
 * First-person FUTURE intent to run one of those actions. Future tense only, so
 * a truthful past-tense report ("I added the card and ran the tests") is never
 * nudged — that turn is a summary, not a stall. Up to two filler words allow
 * "I'll first search" and "I will then create" without stretching far enough to
 * swallow "I will explain how to add ...".
 */
const INTENT_TO_ACT = new RegExp(
  String.raw`\b(?:i (?:will|need to|plan to|am going to|am about to)|i'?ll|i'?m going to|let me|we (?:will|should)|next,? i(?:'?ll| will))\s+(?:\w+\s+){0,2}?(?:${ACTION_VERB})\b`,
  "i"
);

/**
 * The same signal in Hebrew, where the future tense is a verb prefix rather than
 * an auxiliary, so the English patterns cannot see it. The coder writes in the
 * user's language often enough for this to be a first-class case.
 */
const HEBREW_INTENT_TO_ACT =
  /(?:^|[\s,.:!?"'([])(?:אני\s+)?(?:כעת\s+|עכשיו\s+)?(?:אוסיף|אחפש|אקרא|אערוך|אצור|אכתוב|אריץ|אתקן|אעדכן|אשנה|אבצע|אבדוק|אמחק|אחליף|נתחיל)/;

/**
 * Count `1.` / `2)` style list items that start a line. Three or more of them in
 * a turn that called no tool is a plan being narrated, not an answer being
 * given. Requires ascending-from-one numbering so an enumerated quote or a
 * version list ("3. 1.2.4") does not read as a plan.
 */
function countNumberedSteps(text: string): number {
  const numbers = [...text.matchAll(/^\s{0,4}(\d{1,2})[.)]\s+\S/gm)].map((m) => Number(m[1]));
  if (numbers[0] !== 1) return 0;
  let expected = 1;
  for (const n of numbers) {
    if (n === expected) expected++;
  }
  return expected - 1;
}
