import { AIProvider, ChatMessage, ImageAttachment } from "../providers/types";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { Agent, AgentConfig, AgentEvents, RestoredMessage } from "./Agent";
import {
  buildCommunicatorInPrompt,
  buildCommunicatorOutPrompt,
} from "./prompts";
import { classifyRoute } from "./routing";
import { trimHistory } from "./history";
import { describeAction } from "./actions";

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
  /** The conversation's context file — given to BOTH roles on every turn. */
  private sessionContext = "";

  constructor(
    private readonly communicator: RoleModel,
    private readonly coder: RoleModel,
    private readonly tools: ToolRegistry,
    private readonly project: ProjectContext,
    private readonly memory: Memory,
    private readonly config: AgentConfig,
    private readonly workspaceRoot: string
  ) {}

  /** Set by {@link cancel}, cleared at the start of each run. */
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    this.currentCoder?.cancel();
  }

  reset(): void {
    this.currentCoder?.reset();
    this.history = [];
    this.sessionContext = "";
    // Must go too: a coder built later (the pipeline creates it lazily, on the
    // first CODE turn) would otherwise be seeded with the conversation the user
    // just closed — the previous thread leaking into a brand-new task.
    this.restored = undefined;
  }

  /** Give both roles the conversation's persistent context file. */
  setSessionContext(text: string): void {
    this.sessionContext = text;
    this.currentCoder?.setSessionContext(text);
  }

  /**
   * Replay a saved conversation into BOTH roles. The communicator needs it to
   * keep talking coherently; the coder needs it so a follow-up like "now add the
   * page too" refers to something it knows about.
   */
  restore(messages: RestoredMessage[]): void {
    this.history = messages
      .filter((m) => m.content?.trim())
      .map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
    this.currentCoder?.restore(messages);
    this.restored = messages;
  }

  /** Kept so a coder built later in the conversation still gets the backlog. */
  private restored?: RestoredMessage[];

  async run(
    userMessage: string,
    events: AgentEvents,
    images?: ImageAttachment[]
  ): Promise<void> {
    this.cancelled = false;
    try {
      const summary = await this.project.summarize();
      // Conversation so far, BEFORE this turn — reused by both communicator calls.
      const priorHistory = trimHistory(this.history);

      // ---- Phase 1: communicator understands the user and ROUTES -----------
      events.onPhase?.("communicator-in", "🗣️ Language bot is reading your message…");
      const routeResponse = await this.communicator.provider.complete({
        system: buildCommunicatorInPrompt(summary, this.config.language, this.sessionContext),
        messages: [...priorHistory, { role: "user", content: userMessage, images }],
        tools: [],
        model: this.communicator.model,
        temperature: 0.2,
        maxTokens: 1200,
      });
      for (const warning of routeResponse.warnings ?? []) events.onLog(`⚠️ ${warning}`);
      const route = classifyRoute(routeResponse.text, userMessage);

      // CHAT: the language bot answers directly — no coder involved.
      if (route.kind === "chat") {
        events.onPhase?.("route-chat", "🧭 Handled directly (conversation)");
        const answer = route.content || "🙂";
        events.onAssistantText(answer);
        this.history.push({ role: "user", content: userMessage }, { role: "assistant", content: answer });
        // Keep the coder's memory in step even though it did not run: a chat turn
        // ("call it Test, not waycode") is context the NEXT code turn depends on.
        this.currentCoder?.noteExchange(userMessage, answer);
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
      // The Agent reports provider failures through onError and returns normally,
      // so a dead endpoint looks exactly like "did nothing" from here. Capture it:
      // nudging a coder whose provider is down just repeats the same error.
      const failure = { message: "" };
      const coderEvents = this.wrapForCoder(events, actions, failure);
      // Reuse one coder across turns so follow-up requests keep prior context.
      if (!this.currentCoder) {
        this.currentCoder = new Agent(
          this.coder.provider,
          this.tools,
          this.project,
          this.memory,
          // The coder ALWAYS works in English, whatever the user's reply
          // language. Spreading the config unchanged told it "always reply in
          // Hebrew" — the exact thing this prompt warns the communicator about —
          // and a small code model spends its whole budget failing at that: the
          // observed output degenerated into mixed Hebrew/Arabic and it stopped
          // calling tools entirely. Translating back is the communicator's job.
          { ...this.config, model: this.coder.model, language: "English" },
          this.workspaceRoot
        );
        // A conversation restored before the coder existed still reaches it.
        if (this.restored) this.currentCoder.restore(this.restored);
        this.currentCoder.setSessionContext(this.sessionContext);
      }
      let coderSummary = await this.currentCoder.run(spec, coderEvents, images);

      // Stop means stop. Every nudge below calls Agent.run again, which clears
      // the agent's own cancelled flag — so without this the user pressing Stop
      // watched the coder start straight back up.
      if (this.cancelled) {
        events.onLog("⏹️ Cancelled by user.");
        events.onDone();
        return;
      }

      // If the coder stalled (produced a plan but ran no tools), nudge it once
      // to actually act instead of asking the user to confirm.
      if (actions.length === 0 && !failure.message) {
        events.onLog("↻ Coder ran no tools — nudging it to act.");
        coderSummary = await this.currentCoder.run(
          "You did not use any tools, so nothing was done. Do the task NOW by calling the tools (search/read/edit/create/run). Do not ask for confirmation and do not just describe a plan.",
          coderEvents
        );
      }

      // A multi-part request ("write the README *and* the landing page") is the
      // classic half-finish: the coder does the first file, reports success, and
      // silently drops the rest. Compare the files the spec named against the
      // files any tool actually touched, and make it finish the remainder.
      const missing =
        failure.message || this.cancelled ? [] : untouchedTargets(spec, actions);
      if (missing.length) {
        events.onLog(`↻ Deliverables not touched yet: ${missing.join(", ")} — asking the coder to finish.`);
        coderSummary = await this.currentCoder.run(
          `The task is NOT finished. These files from the task were never created or edited: ${missing.join(
            ", "
          )}. Create or edit them NOW with create_file / edit_file / write_file, in this turn. Do not ask for confirmation and do not just describe a plan.`,
          coderEvents
        );
      }

      // ---- Phase 3: communicator explains the result -----------------------
      events.onPhase?.("communicator-out", "🗣️ Language bot is preparing the explanation…");
      const changed = actions.some((a) => a.startsWith("changed:"));
      const verified = actions.some((a) => a.startsWith("ran:"));
      const groundTruth = [
        actions.length ? actions.join("\n") : "(NO tools were run and NO changes were made.)",
        // Without this the explanation bot cheerfully reports a completed task
        // that in fact never started, because a crashed coder leaves no actions.
        failure.message
          ? `The coder FAILED with an error and could not work: ${failure.message}. Tell the user plainly that the task did not run, and why.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const explainResponse = await this.communicator.provider.complete({
        system: buildCommunicatorOutPrompt(this.config.language, this.sessionContext),
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
      for (const warning of explainResponse.warnings ?? []) events.onLog(`⚠️ ${warning}`);
      const explanation = explainResponse.text.trim() || coderSummary || "Done.";
      events.onAssistantText(explanation);
      // Only the real exchange enters history — not the internal spec/ground-truth.
      this.history.push({ role: "user", content: userMessage }, { role: "assistant", content: explanation });
      // Both roles finish the turn believing the same thing happened: the coder
      // worked from an English spec, so tell it what the user actually asked and
      // what they were actually told.
      this.currentCoder?.noteExchange(
        `(For context — the user's own words for the task you just did: ${userMessage})`,
        `(What the user was told: ${explanation})`
      );
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
  private wrapForCoder(
    events: AgentEvents,
    actions: string[],
    failure: { message: string }
  ): AgentEvents {
    return {
      onAssistantText: (t) => events.onThinking(`👨‍💻 ${t}`),
      onThinking: (t) => events.onThinking(t),
      onToolStart: (c) => events.onToolStart(c),
      onToolEnd: (c, r, p) => {
        actions.push(describeAction(c, r));
        events.onToolEnd(c, r, p);
      },
      onLog: (m) => events.onLog(m),
      requestApproval: (p) => events.requestApproval(p),
      onError: (m) => {
        failure.message = m;
        events.onError(m);
      },
      onDone: () => {
        /* controlled by the orchestrator */
      },
    };
  }
}

/**
 * Extensions we are confident name a real deliverable file. Deliberately a
 * closed list: an open `\.\w+` pattern would also match `example.com`,
 * `package.json`-style search terms, and version numbers, and every false
 * positive costs the user a pointless extra coder round-trip.
 */
const SOURCE_EXTENSIONS = new Set([
  "c", "cjs", "cpp", "cs", "css", "go", "h", "htm", "html", "java", "js", "json",
  "jsx", "kt", "less", "md", "mjs", "php", "py", "rb", "rs", "scss", "sh", "sql",
  "svelte", "svg", "swift", "toml", "ts", "tsx", "txt", "vue", "yaml", "yml",
]);

/** The headers of the task-spec template, used to find section boundaries. */
const SPEC_SECTION =
  /^\s*(goal|search terms|deliverables|details\s*\/\s*constraints|details|constraints|acceptance criteria)\s*:/i;

/**
 * The concrete files a task spec asks the coder to PRODUCE.
 *
 * The explicit "Deliverables" section wins when present, because the rest of the
 * spec also names files that are only references to read ("model the new page on
 * tikunchik.html") — demanding a write to those would be wrong. Without that
 * section we fall back to the whole spec minus "Search terms", whose entries are
 * grep needles (package names, hostnames), not files.
 */
export function specTargets(spec: string): string[] {
  const lines = (spec || "").split("\n");
  const start = lines.findIndex((l) => /^\s*deliverables\s*:/i.test(l));
  let body: string;
  if (start !== -1) {
    const section = [lines[start].replace(/^\s*deliverables\s*:/i, "")];
    for (let i = start + 1; i < lines.length && !SPEC_SECTION.test(lines[i]); i++) {
      section.push(lines[i]);
    }
    body = section.join("\n");
  } else {
    body = lines.filter((l) => !/^\s*search terms\s*:/i.test(l)).join("\n");
  }
  const found = new Set<string>();
  for (const raw of body.match(/[\w./\\-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g) ?? []) {
    // Normalise separators and drop a leading "./" only — an absolute path must
    // keep its root slash so the nudge message names the file the user knows.
    const token = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
    const ext = token.slice(token.lastIndexOf(".") + 1).toLowerCase();
    if (SOURCE_EXTENSIONS.has(ext)) found.add(token);
  }
  return [...found];
}

/**
 * Only a WRITE proves a deliverable was produced. Searching for `index.html` or
 * reading it does not — and counting those was hiding the exact failure this
 * check exists to catch: a coder that greps for the target, finds nothing, and
 * gives up without creating it.
 */
const WRITE_ACTION = /^(changed|attempted-change):/;

/**
 * Files the spec asked for that no write ever produced — i.e. the part of the
 * request that was silently dropped. Matching is on the basename so a spec that
 * says `src/index.html` is satisfied by a tool call on `./src/index.html`.
 */
export function untouchedTargets(spec: string, actions: string[]): string[] {
  const written = actions
    .filter((a) => WRITE_ACTION.test(a))
    .join("\n")
    .toLowerCase();
  return specTargets(spec).filter((t) => {
    const base = t.slice(t.lastIndexOf("/") + 1).toLowerCase();
    return !written.includes(base);
  });
}
