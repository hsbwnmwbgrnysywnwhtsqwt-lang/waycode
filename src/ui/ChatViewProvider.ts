import * as vscode from "vscode";
import * as fs from "fs/promises";
import { Agent, AgentEvents, RestoredMessage, RunPolicy } from "../agent/Agent";
import { Orchestrator, RoleModel } from "../agent/Orchestrator";
import { describeAction } from "../agent/actions";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { Config, AgentRole } from "../config";
import { createProvider, PROVIDER_META, ProviderId } from "../providers/ProviderFactory";
import { ToolPreview } from "../tools/Tool";
import { ImageAttachment } from "../providers/types";
import { safeResolve, toRelative } from "../tools/pathUtils";
import { History, Session } from "../memory/History";
import { NOTES_HEADER, SessionNotes } from "../memory/SessionNotes";
import {
  generatedName,
  isBinary,
  isImage,
  MAX_PASTE_BYTES,
  numbered,
  sanitizeFileName,
  UPLOAD_DIR,
  MAX_IMAGE_BYTES,
  mediaTypeFor,
} from "./attachments";

/** Anything the chat can drive: a single Agent or the multi-agent Orchestrator. */
interface Runner {
  cancel(): void;
  reset(): void;
  /** Replay a saved conversation so a reopened thread is not amnesiac. */
  restore(messages: RestoredMessage[]): void;
  /** The conversation's context file, refreshed before every turn. */
  setSessionContext(text: string): void;
  run(userMessage: string, events: AgentEvents, images?: ImageAttachment[]): Promise<unknown>;
}

/**
 * The chat's core logic, independent of where it's shown. It can drive several
 * webviews at once (the sidebar view AND a full editor panel), which share one
 * conversation, runner, and live run-policy.
 */
export class ChatController {
  private readonly webviews = new Set<vscode.Webview>();
  /** Per-webview listener subscriptions, released on unbind so nothing leaks. */
  private readonly subscriptions = new Map<vscode.Webview, vscode.Disposable>();
  private runner?: Runner;
  private runnerSig?: string;
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  private approvalSeq = 0;

  /** Live policy — toggled from the UI (moon/plan) and read by the agent live. */
  private readonly policy: RunPolicy = {
    autoApproveReads: true,
    autoApproveWrites: false,
    autoApproveCommands: false,
    planMode: false,
  };

  /** The conversation currently being recorded, and the last assistant reply. */
  private session?: Session;
  private lastAssistant = "";
  /** The current conversation's context file (see {@link SessionNotes}). */
  private notes?: SessionNotes;
  /** Set when the runner must be re-seeded from the session before the next turn. */
  private needsRestore = false;
  /** True while a turn is in flight — a second concurrent turn is refused. */
  private running = false;
  /** Set when Stop was pressed, so a queued follow-up is not silently dropped. */
  private cancelRequested = false;
  /** Messages typed while a turn was running, run in order once it finishes. */
  private queued: Array<{ text: string; context: string[] }> = [];
  /** Ground-truth tool actions of the turn in flight, for the context file. */
  private turnActions: string[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memory: Memory,
    private readonly config: Config,
    private readonly history: History,
    /** Directory holding the per-conversation context files. */
    private readonly notesDir: string
  ) {}

  /** Attach a webview (sidebar or panel). */
  bind(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webview.html = this.html(webview);
    this.webviews.add(webview);
    this.subscriptions.get(webview)?.dispose();
    this.subscriptions.set(
      webview,
      webview.onDidReceiveMessage((msg) => this.onMessage(msg))
    );
  }

  unbind(webview: vscode.Webview): void {
    this.webviews.delete(webview);
    this.subscriptions.get(webview)?.dispose();
    this.subscriptions.delete(webview);
  }

  focusInput(): void {
    this.post({ type: "focusInput" });
  }

  prefill(text: string): void {
    this.post({ type: "prefill", text });
  }

  notify(text: string): void {
    this.post({ type: "log", text });
  }

  /** Attach a file (by workspace-relative path) as a context chip. */
  attachContext(relPath: string): void {
    this.post({ type: "contextAdded", path: relPath });
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "send":
        await this.handleSend(
          String(msg.text ?? ""),
          Array.isArray(msg.context) ? msg.context.map(String) : []
        );
        break;
      case "pickContext":
        await this.pickContext();
        break;
      case "upload":
        await this.uploadFiles();
        break;
      case "pasteFile":
        await this.savePastedFile(
          String(msg.name ?? ""),
          String(msg.mime ?? ""),
          String(msg.base64 ?? "")
        );
        break;
      case "openSettings":
        await vscode.commands.executeCommand("waycode.openSettings");
        break;
      case "approval":
        this.resolveApproval(String(msg.id), Boolean(msg.approved));
        break;
      case "cancel":
        this.cancelRequested = true;
        this.runner?.cancel();
        break;
      case "newTask":
        await this.newTask();
        break;
      case "history":
        await this.showHistory();
        break;
      case "setMode":
        await this.setMode(String(msg.mode));
        break;
      case "ready":
        this.broadcastState();
        // A webview that was disposed and rebuilt (sidebar hidden, or the editor
        // tab closed and reopened) starts blank — repaint the live conversation
        // instead of leaving the user staring at an empty panel.
        if (this.session?.messages.length) {
          this.post({
            type: "restore",
            messages: this.session.messages,
            note: "↩︎ Reattached to the conversation in progress.",
          });
        }
        break;
    }
  }

  /** Derive the current mode name from the live policy. */
  private currentMode(): "manual" | "autoEdit" | "plan" | "auto" {
    if (this.policy.planMode) return "plan";
    if (this.policy.autoApproveWrites && this.policy.autoApproveCommands) return "auto";
    if (this.policy.autoApproveWrites) return "autoEdit";
    return "manual";
  }

  /** Apply a mode (Manual / Auto-edit / Plan / Auto) to the live policy. */
  private async setMode(mode: string): Promise<void> {
    this.policy.planMode = mode === "plan";
    const writes = mode === "autoEdit" || mode === "auto";
    const commands = mode === "auto";
    this.policy.autoApproveReads = true;
    this.policy.autoApproveWrites = writes;
    this.policy.autoApproveCommands = commands;
    await this.config.setApprovalMode({ reads: true, fileEdits: writes, commands });
    this.broadcastState();
  }

  private broadcastState(): void {
    this.post({ type: "status", text: this.statusLine() });
    this.post({ type: "modeState", mode: this.currentMode() });
  }

  private statusLine(): string {
    const modeLabels: Record<string, string> = {
      manual: "✋ manual",
      autoEdit: "⟨⟩ auto-edit",
      plan: "📋 plan",
      auto: "🌙 auto",
    };
    const mode = `  ·  ${modeLabels[this.currentMode()]}`;
    const lang = this.config.language !== "auto" ? `  ·  🌐 ${this.config.language}` : "";
    if (this.config.multiAgentEnabled) {
      const comm = this.config.roleModel("communicator");
      const coder = this.config.roleModel("coder");
      return `🗣️ ${comm}  →  👨‍💻 ${coder}${mode}${lang}`;
    }
    const p = this.config.provider;
    return `${PROVIDER_META[p].label} · ${this.config.model}${mode}${lang}`;
  }

  private async buildRole(role: AgentRole): Promise<RoleModel | { error: string }> {
    const providerId: ProviderId = this.config.roleProvider(role);
    const creds = await this.config.credentialsFor(providerId);
    if (PROVIDER_META[providerId].requiresApiKey && !creds.apiKey) {
      return {
        error: `No API key for ${PROVIDER_META[providerId].label} (used by the ${role} role). Run 'WayCode: Set API Key'.`,
      };
    }
    return { provider: createProvider(providerId, creds), model: this.config.roleModel(role) };
  }

  /** Identity of the model/mode/language; a change forces a fresh runner. Approval
   * and plan mode are intentionally excluded — they live in the shared policy. */
  private runnerSignature(root: string): string {
    const c = this.config;
    const common = `${root}|${c.language}|${c.maxAgentSteps}`;
    if (c.multiAgentEnabled) {
      return `multi|${c.roleProvider("communicator")}:${c.roleModel("communicator")}|${c.roleProvider(
        "coder"
      )}:${c.roleModel("coder")}|${common}`;
    }
    return `single|${c.provider}:${c.model}|${common}`;
  }

  private agentConfig() {
    return {
      model: this.config.model,
      maxSteps: this.config.maxAgentSteps,
      language: this.config.language,
      policy: this.policy,
    };
  }

  private async buildRunner(root: string): Promise<Runner | undefined> {
    const cfg = this.agentConfig();
    if (this.config.multiAgentEnabled) {
      if (this.config.roleProvider("coder") === "claude-cli") {
        this.post({
          type: "error",
          text: "Claude CLI can't be the coder — it's text-only and has no WayCode tools, so it times out. In Settings, set the coder to Ollama (e.g. qwen2.5-coder) or the Anthropic API. For the communicator, a local Ollama model like gemma2:9b works great.",
        });
        return undefined;
      }
      const comm = await this.buildRole("communicator");
      const coder = await this.buildRole("coder");
      if ("error" in comm) {
        this.post({ type: "error", text: comm.error });
        return undefined;
      }
      if ("error" in coder) {
        this.post({ type: "error", text: coder.error });
        return undefined;
      }
      return new Orchestrator(
        comm,
        coder,
        ToolRegistry.default(),
        new ProjectContext(root),
        this.memory,
        cfg,
        root
      );
    }
    const providerId = this.config.provider;
    const creds = await this.config.credentialsFor(providerId);
    if (PROVIDER_META[providerId].requiresApiKey && !creds.apiKey) {
      this.post({
        type: "error",
        text: `No API key for ${PROVIDER_META[providerId].label}. Run 'WayCode: Set API Key'.`,
      });
      return undefined;
    }
    return new Agent(
      createProvider(providerId, creds),
      ToolRegistry.default(),
      new ProjectContext(root),
      this.memory,
      cfg,
      root
    );
  }

  private async handleSend(
    text: string,
    context: string[] = [],
    alreadyShown = false
  ): Promise<void> {
    if (!text.trim() && !context.length) return;

    // Two turns sharing one runner interleave their messages, which corrupts the
    // tool_use/tool_result pairing and makes every later request fail. The UI
    // disables Send during a run, but an error mid-run — or a second webview —
    // can still get a message through, so the guard lives here.
    if (this.running) {
      // Don't make the user sit and wait for the turn to end: take the message
      // now and run it the moment the current one finishes. Two turns may not
      // share the runner at the same time (interleaved messages corrupt the
      // tool_use/tool_result pairing), so queueing — not running — is the fix.
      this.queued.push({ text, context });
      this.post({ type: "userMessage", text, queued: true });
      this.post({
        type: "log",
        text: `⏳ Queued — will run when the current message finishes (${this.queued.length} waiting).`,
      });
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: "error", text: "Open a folder/workspace first." });
      return;
    }
    const root = folder.uri.fsPath;
    // Inject any attached files' contents into the message the model sees.
    const contextBlock = await this.readContext(root, context);
    const images = await this.readImages(root, context);
    const modelText = contextBlock ? `${contextBlock}\n\n---\n\n${text}` : text;

    // Pick up approval changes made via the Command Palette (plan mode is UI-only).
    this.policy.autoApproveReads = this.config.autoApproveReads;
    this.policy.autoApproveWrites = this.config.autoApproveFileEdits;
    this.policy.autoApproveCommands = this.config.autoApproveCommands;

    const signature = this.runnerSignature(root);
    if (!this.runner || signature !== this.runnerSig) {
      const built = await this.buildRunner(root);
      if (!built) return;
      this.runner = built;
      this.runnerSig = signature;
      // A fresh runner has no memory of the thread it is joining — whether that
      // is a reopened conversation, a window reload, or a mid-thread model
      // switch. Replay what has already been said.
      this.needsRestore = true;
    }

    // Record the turn in the per-project conversation history.
    if (!this.session) this.session = History.newSession(root);
    if (!this.session.title) this.session.title = text.slice(0, 80) || "(context)";

    // Replay BEFORE this turn's message is appended, so it is not sent twice.
    if (this.needsRestore) {
      this.needsRestore = false;
      if (this.session.messages.length) {
        this.runner.restore(this.session.messages);
        this.post({
          type: "log",
          text: `🧠 Restored ${this.session.messages.length} earlier messages into the model's context.`,
        });
      }
    }

    // Both bots read the conversation's context file at the start of every turn.
    if (!this.notes) this.notes = new SessionNotes(this.notesDir, this.session.id);
    this.runner.setSessionContext(await this.notes.render());

    this.session.messages.push({ role: "user", content: text });
    this.lastAssistant = "";
    this.turnActions = [];

    if (!alreadyShown) this.post({ type: "userMessage", text });
    if (context.length) this.post({ type: "log", text: `📎 Attached: ${context.join(", ")}` });
    this.post({ type: "running", value: true });

    const events: AgentEvents = {
      onAssistantText: (t) => {
        this.lastAssistant = t;
        this.post({ type: "assistant", text: t });
      },
      onThinking: (t) => this.post({ type: "thinking", text: t }),
      onToolStart: (call) =>
        this.post({ type: "toolStart", id: call.id, name: call.name, input: call.input }),
      onToolEnd: (call, result, preview) => {
        this.turnActions.push(describeAction(call, result));
        this.post({
          type: "toolEnd",
          id: call.id,
          name: call.name,
          isError: result.isError ?? false,
          output: result.content,
          preview,
        });
      },
      onLog: (m) => this.post({ type: "log", text: m }),
      requestApproval: (preview) => this.askApproval(preview),
      onError: (m) => this.post({ type: "error", text: m }),
      onDone: () => {
        this.post({ type: "running", value: false });
        void this.recordAssistant();
      },
      onPhase: (name, label) => this.post({ type: "phase", name, label }),
    };

    this.running = true;
    this.cancelRequested = false;
    try {
      await this.runner.run(modelText, events, images);
    } catch (err) {
      // The runners handle their own errors, so this is the unexpected kind —
      // it must still clear the UI's running state, or the chat stays stuck on
      // "Stop" with no way back.
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
      this.post({ type: "running", value: false });
    }
    await this.drainQueue();
  }

  /**
   * Run the messages typed while the previous turn was in flight, oldest first.
   *
   * Pressing Stop discards them: Stop means "not this direction", so silently
   * running the follow-ups that were queued behind it would be the opposite of
   * what was asked. Iterative rather than recursive so a long queue cannot build
   * a deep stack.
   */
  private async drainQueue(): Promise<void> {
    if (this.cancelRequested && this.queued.length) {
      const dropped = this.queued.length;
      this.queued = [];
      this.post({
        type: "log",
        text: `⏹️ Stopped — discarded ${dropped} queued message${dropped > 1 ? "s" : ""}. Send again when you're ready.`,
      });
      return;
    }
    while (this.queued.length && !this.running) {
      const next = this.queued.shift();
      if (!next) break;
      await this.handleSend(next.text, next.context, true);
    }
  }

  /**
   * Close out a turn: append the reply to the session, persist it, and record
   * the turn in the conversation's context file so the next turn (or a much
   * later reopen) still knows what was asked and what actually ran.
   */
  private async recordAssistant(): Promise<void> {
    if (!this.session) return;
    if (this.lastAssistant.trim()) {
      this.session.messages.push({ role: "assistant", content: this.lastAssistant });
    }
    this.session.ts = Date.now();
    await this.history.save(this.session);

    const lastUser = [...this.session.messages].reverse().find((m) => m.role === "user");
    await this.notes?.appendTurn({
      request: lastUser?.content ?? "",
      actions: this.turnActions,
      result: this.lastAssistant,
    });
    this.turnActions = [];
  }

  /**
   * Start a fresh task: save the current conversation, drop it out of the
   * runner, and clear the view. Public because the "WayCode: New Task" command
   * used to only announce a new task without starting one — the next message
   * still carried the whole previous conversation.
   */
  async newTask(): Promise<void> {
    // Anything still waiting belongs to the thread being closed.
    this.queued = [];
    await this.finalizeSession();
    this.runner?.reset();
    this.session = undefined;
    this.notes = undefined;
    this.needsRestore = false;
    this.lastAssistant = "";
    this.turnActions = [];
    this.post({ type: "cleared" });
  }

  /** Open this conversation's context file in an editor. */
  async openSessionContextFile(): Promise<void> {
    if (!this.notes) {
      this.post({
        type: "log",
        text: "No conversation context file yet — send a message first.",
      });
      return;
    }
    const uri = vscode.Uri.file(this.notes.filePath());
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      const body = (await this.notes.read()) || NOTES_HEADER;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(body, "utf8"));
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  }

  private async finalizeSession(): Promise<void> {
    if (this.session) await this.history.save(this.session);
  }

  /** Show past conversations for this workspace and load the chosen one. */
  private async showHistory(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const sessions = this.history.list(folder.uri.fsPath);
    if (!sessions.length) {
      this.post({ type: "log", text: "No saved conversations yet for this project." });
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.title || "(untitled)",
        description: new Date(s.ts).toLocaleString(),
        detail: `${s.messages.length} messages`,
        id: s.id,
      })),
      { title: "WayCode: Conversation history", matchOnDescription: true }
    );
    if (!pick) return;
    this.loadSession(pick.id);
  }

  private loadSession(id: string): void {
    const s = this.history.get(id);
    if (!s) return;
    void this.finalizeSession();
    // Clear the old thread out of the runner, then queue the loaded one to be
    // replayed into it. Repainting the webview alone used to leave the MODEL
    // with no memory of the conversation the user could see on screen.
    this.runner?.reset();
    this.session = s;
    this.notes = new SessionNotes(this.notesDir, s.id);
    this.needsRestore = true;
    this.post({
      type: "restore",
      messages: s.messages,
      note: "↩︎ Loaded a saved conversation — its context has been restored for both bots.",
    });
  }

  /** Public entry for the History command. */
  openHistory(): void {
    void this.showHistory();
  }

  /**
   * Load attached images as base64 so a vision-capable model can actually see
   * them, rather than only being told a picture exists at a path. Providers
   * without vision ignore the field, so this is safe to always populate.
   */
  private async readImages(root: string, context: string[]): Promise<ImageAttachment[]> {
    const out: ImageAttachment[] = [];
    for (const rel of context) {
      if (!isImage(rel) || rel.toLowerCase().endsWith(".svg")) continue;
      try {
        const bytes = await fs.readFile(safeResolve(root, rel));
        if (bytes.length > MAX_IMAGE_BYTES) {
          this.post({
            type: "log",
            text: `🖼️ ${rel} is too large to send to the model (${Math.round(bytes.length / 1e6)} MB); it is still on disk for the tools.`,
          });
          continue;
        }
        out.push({ mediaType: mediaTypeFor(rel), base64: bytes.toString("base64"), path: rel });
      } catch {
        /* unreadable — the context block already names it */
      }
    }
    if (out.length) {
      this.post({ type: "log", text: `👁️ Sending ${out.length} image(s) to the model.` });
    }
    return out;
  }

  /** Read attached files and format them as a context block for the model. */
  private async readContext(root: string, context: string[]): Promise<string> {
    if (!context.length) return "";
    const blocks: string[] = [];
    for (const rel of context) {
      try {
        const abs = safeResolve(root, rel);
        // Inlining a PNG as UTF-8 produces pages of mojibake that crowd out the
        // real context. Name the file instead, and point the agent at the path —
        // it is inside the workspace, so every tool can reach it.
        if (isBinary(rel)) {
          const stat = await fs.stat(abs);
          blocks.push(
            `### ${rel}\n(${isImage(rel) ? "image" : "binary file"}, ${Math.round(
              stat.size / 1024
            )} KB — available at this path in the workspace)`
          );
          continue;
        }
        let content = await fs.readFile(abs, "utf8");
        if (content.length > 20_000) content = content.slice(0, 20_000) + "\n… [truncated]";
        blocks.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        /* skip unreadable files */
      }
    }
    return blocks.length ? `The user attached these files as context:\n\n${blocks.join("\n\n")}` : "";
  }

  /**
   * Upload files or images from ANYWHERE on disk (not just the workspace).
   *
   * They are copied into `.waycode/uploads/` inside the workspace and attached as
   * ordinary context chips. Copying rather than referencing is deliberate: every
   * WayCode tool resolves paths inside the workspace and refuses to escape it, so
   * a file left outside would be visible to the chat but unreadable to the agent.
   */
  async uploadFiles(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: "error", text: "Open a folder/workspace first." });
      return;
    }
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach to WayCode",
      title: "WayCode: upload files or images",
    });
    if (!picks?.length) return;

    const root = folder.uri.fsPath;
    const destDir = vscode.Uri.file(safeResolve(root, UPLOAD_DIR));
    await vscode.workspace.fs.createDirectory(destDir);
    await this.ensureUploadsIgnored(destDir);

    for (const src of picks) {
      const base = src.fsPath.split(/[\\/]/).pop() || "upload";
      const dest = vscode.Uri.joinPath(destDir, base);
      try {
        // Never clobber an earlier upload of the same name.
        let target = dest;
        for (let n = 1; await exists(target); n++) {
          target = vscode.Uri.joinPath(destDir, numbered(base, n));
        }
        await vscode.workspace.fs.copy(src, target, { overwrite: false });
        const rel = toRelative(root, target.fsPath);
        this.post({ type: "contextAdded", path: rel });
        this.post({
          type: "log",
          text: `${isImage(base) ? "🖼️" : "📎"} Uploaded ${base} → ${rel}`,
        });
      } catch (err) {
        this.post({
          type: "error",
          text: `Could not upload ${base}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  /**
   * Save a file pasted (Cmd+V) or dropped into the chat. A clipboard screenshot
   * arrives with no name at all, so one is generated from the MIME type — that
   * is the common case and it must not be dropped for lack of a filename.
   */
  private async savePastedFile(name: string, mime: string, base64: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: "error", text: "Open a folder/workspace first." });
      return;
    }
    if (!base64) return;
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) return;
    if (bytes.length > MAX_PASTE_BYTES) {
      this.post({
        type: "error",
        text: `That file is ${Math.round(bytes.length / 1e6)} MB — too large to attach (limit ${
          MAX_PASTE_BYTES / 1e6
        } MB). Save it into the project and use ➕ instead.`,
      });
      return;
    }

    const safeName = sanitizeFileName(name) || generatedName(mime);
    const root = folder.uri.fsPath;
    const destDir = vscode.Uri.file(safeResolve(root, UPLOAD_DIR));
    await vscode.workspace.fs.createDirectory(destDir);
    await this.ensureUploadsIgnored(destDir);

    let target = vscode.Uri.joinPath(destDir, safeName);
    for (let n = 1; await exists(target); n++) {
      target = vscode.Uri.joinPath(destDir, numbered(safeName, n));
    }
    await vscode.workspace.fs.writeFile(target, bytes);

    const rel = toRelative(root, target.fsPath);
    this.post({ type: "contextAdded", path: rel });
    this.post({
      type: "log",
      text: `${isImage(safeName) ? "🖼️" : "📎"} Saved ${rel} (${Math.round(bytes.length / 1024)} KB)`,
    });
  }

  /**
   * Keep pasted and uploaded files out of the user's commits. WayCode copies
   * attachments INTO the workspace so its tools can reach them; that must not
   * turn into surprise files in their next `git add .`.
   */
  private async ensureUploadsIgnored(destDir: vscode.Uri): Promise<void> {
    const marker = vscode.Uri.joinPath(destDir, ".gitignore");
    if (await exists(marker)) return;
    await vscode.workspace.fs.writeFile(
      marker,
      Buffer.from("# Files attached to WayCode chats — not part of the project.\n*\n", "utf8")
    );
  }

  /** Let the user pick workspace files to attach as context for the next message. */
  async pickContext(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: "error", text: "Open a folder/workspace first." });
      return;
    }
    const files = await vscode.workspace.findFiles("**/*", "**/{node_modules,out,dist,.git,.next}/**", 3000);
    const items = files
      .map((f) => ({ label: toRelative(folder.uri.fsPath, f.fsPath) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const picks = await vscode.window.showQuickPick(items, {
      title: "WayCode: Attach files as context",
      canPickMany: true,
      placeHolder: "Pick one or more files to include with your next message",
    });
    if (!picks || !picks.length) return;
    for (const p of picks) this.post({ type: "contextAdded", path: p.label });
  }

  private askApproval(preview: ToolPreview): Promise<boolean> {
    const id = `approval-${this.approvalSeq++}`;
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(id, resolve);
      this.post({ type: "approvalRequest", id, preview });
    });
  }

  private resolveApproval(id: string, approved: boolean): void {
    const resolver = this.pendingApprovals.get(id);
    if (resolver) {
      this.pendingApprovals.delete(id);
      resolver(approved);
    }
  }

  private post(message: unknown): void {
    for (const webview of [...this.webviews]) {
      // A closed panel/view can still be in the set for a moment; postMessage on
      // a disposed webview throws synchronously on some VS Code versions and
      // rejects on others. Drop it either way instead of crashing the extension
      // or leaving an unhandled rejection behind.
      try {
        Promise.resolve(webview.postMessage(message)).catch(() => this.unbind(webview));
      } catch {
        this.unbind(webview);
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", name));
    const scriptUri = asset("main.js");
    const styleUri = asset("style.css");
    // Both logo variants are loaded; CSS shows the one that suits the theme.
    const logoLight = asset("logo-light.png");
    const logoDark = asset("logo-dark.png");
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>WayCode</title>
</head>
<body data-logo-light="${logoLight}" data-logo-dark="${logoDark}">
  <header class="topbar">
    <span class="brand">
      <img class="brand-logo logo-light" src="${logoLight}" alt="" />
      <img class="brand-logo logo-dark" src="${logoDark}" alt="" />
      WayCode
    </span>
    <span class="topbar-actions">
      <button id="newTask" class="toggle" title="Start a new task">✚</button>
      <button id="historyBtn" class="toggle" title="Conversation history">🕘</button>
      <button id="settingsBtn" class="toggle" title="WayCode settings">⚙</button>
    </span>
  </header>
  <div id="status" class="status"></div>
  <div id="messages" class="messages"></div>
  <div class="composer">
    <div id="chips" class="chips"></div>
    <textarea id="input" rows="3" placeholder="Ask WayCode…  (Enter to send, Shift+Enter = newline)"></textarea>
    <div class="composer-actions">
      <button id="addContext" class="toggle" title="Attach workspace files as context">➕</button>
      <button id="uploadBtn" class="toggle" title="Upload a file or image from anywhere">📎</button>
      <div class="mode-wrap">
        <button id="modeBtn" class="toggle" title="Switch mode (Shift+Tab)">⚡ Mode ▾</button>
        <div id="modeMenu" class="mode-menu hidden"></div>
      </div>
      <span class="spacer"></span>
      <button id="send" class="primary" title="Send (Enter)">Send</button>
      <button id="cancel" class="danger hidden" title="Stop the running task">■ Stop</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Sidebar view — binds a shared ChatController to the WayCode activity-bar view. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "waycode.chatView";
  private view?: vscode.WebviewView;

  constructor(private readonly controller: ChatController) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // Capture the webview NOW: `view.webview` throws "Webview is disposed" once
    // the view is gone, and the dispose handler runs after that point.
    const webview = view.webview;
    this.controller.bind(webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
      this.controller.unbind(webview);
    });
  }

  reveal(): void {
    try {
      this.view?.show?.(true);
    } catch {
      // The view was disposed since we cached it; the container command below
      // recreates it, which triggers resolveWebviewView again.
      this.view = undefined;
      void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }
  }
}

/** Open (or focus) the full-window editor-tab chat, sharing the same controller. */
let panel: vscode.WebviewPanel | undefined;
export function openChatPanel(extensionUri: vscode.Uri, controller: ChatController): void {
  if (panel) {
    try {
      panel.reveal();
      return;
    } catch {
      // Stale handle to a panel that is already gone — fall through and make a
      // new one rather than surfacing "Webview is disposed" to the user.
      panel = undefined;
    }
  }
  const created = vscode.window.createWebviewPanel(
    "waycode.chatPanel",
    "WayCode",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel = created;
  created.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
  // Capture the webview before any disposal: reading `created.webview` inside
  // onDidDispose throws, which is what used to abort the handler and leave the
  // stale `panel` behind — so the NEXT open call revealed a dead panel and
  // failed with "Webview is disposed".
  const webview = created.webview;
  controller.bind(webview);
  created.onDidDispose(() => {
    if (panel === created) panel = undefined;
    controller.unbind(webview);
  });
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
