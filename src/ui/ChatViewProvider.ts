import * as vscode from "vscode";
import * as fs from "fs/promises";
import { Agent, AgentEvents, RunPolicy } from "../agent/Agent";
import { Orchestrator, RoleModel } from "../agent/Orchestrator";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { Config, AgentRole } from "../config";
import { createProvider, PROVIDER_META, ProviderId } from "../providers/ProviderFactory";
import { ToolPreview } from "../tools/Tool";
import { safeResolve, toRelative } from "../tools/pathUtils";
import { History, Session } from "../memory/History";

/** Anything the chat can drive: a single Agent or the multi-agent Orchestrator. */
interface Runner {
  cancel(): void;
  reset(): void;
  run(userMessage: string, events: AgentEvents): Promise<unknown>;
}

/**
 * The chat's core logic, independent of where it's shown. It can drive several
 * webviews at once (the sidebar view AND a full editor panel), which share one
 * conversation, runner, and live run-policy.
 */
export class ChatController {
  private readonly webviews = new Set<vscode.Webview>();
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memory: Memory,
    private readonly config: Config,
    private readonly history: History
  ) {}

  /** Attach a webview (sidebar or panel). Returns a disposable-style unbinder. */
  bind(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webview.html = this.html(webview);
    this.webviews.add(webview);
    webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  unbind(webview: vscode.Webview): void {
    this.webviews.delete(webview);
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
      case "openSettings":
        await vscode.commands.executeCommand("waycode.openSettings");
        break;
      case "approval":
        this.resolveApproval(String(msg.id), Boolean(msg.approved));
        break;
      case "cancel":
        this.runner?.cancel();
        break;
      case "newTask":
        await this.finalizeSession();
        this.runner?.reset();
        this.session = undefined;
        this.post({ type: "cleared" });
        break;
      case "history":
        await this.showHistory();
        break;
      case "setMode":
        await this.setMode(String(msg.mode));
        break;
      case "ready":
        this.broadcastState();
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

  private async handleSend(text: string, context: string[] = []): Promise<void> {
    if (!text.trim() && !context.length) return;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: "error", text: "Open a folder/workspace first." });
      return;
    }
    const root = folder.uri.fsPath;
    // Inject any attached files' contents into the message the model sees.
    const contextBlock = await this.readContext(root, context);
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
    }

    // Record the turn in the per-project conversation history.
    if (!this.session) this.session = History.newSession(root);
    if (!this.session.title) this.session.title = text.slice(0, 80) || "(context)";
    this.session.messages.push({ role: "user", content: text });
    this.lastAssistant = "";

    this.post({ type: "userMessage", text });
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
      onToolEnd: (call, result, preview) =>
        this.post({
          type: "toolEnd",
          id: call.id,
          name: call.name,
          isError: result.isError ?? false,
          output: result.content,
          preview,
        }),
      onLog: (m) => this.post({ type: "log", text: m }),
      requestApproval: (preview) => this.askApproval(preview),
      onError: (m) => this.post({ type: "error", text: m }),
      onDone: () => {
        this.post({ type: "running", value: false });
        void this.recordAssistant();
      },
      onPhase: (name, label) => this.post({ type: "phase", name, label }),
    };

    await this.runner.run(modelText, events);
  }

  /** Append the assistant reply to the current session and persist it. */
  private async recordAssistant(): Promise<void> {
    if (!this.session) return;
    if (this.lastAssistant.trim()) {
      this.session.messages.push({ role: "assistant", content: this.lastAssistant });
    }
    this.session.ts = Date.now();
    await this.history.save(this.session);
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
    this.runner?.reset();
    this.session = s;
    this.post({ type: "restore", messages: s.messages });
  }

  /** Public entry for the History command. */
  openHistory(): void {
    void this.showHistory();
  }

  /** Read attached files and format them as a context block for the model. */
  private async readContext(root: string, context: string[]): Promise<string> {
    if (!context.length) return "";
    const blocks: string[] = [];
    for (const rel of context) {
      try {
        const abs = safeResolve(root, rel);
        let content = await fs.readFile(abs, "utf8");
        if (content.length > 20_000) content = content.slice(0, 20_000) + "\n… [truncated]";
        blocks.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        /* skip unreadable files */
      }
    }
    return blocks.length ? `The user attached these files as context:\n\n${blocks.join("\n\n")}` : "";
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
    for (const webview of this.webviews) {
      webview.postMessage(message);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "style.css"));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
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
<body>
  <header class="topbar">
    <span class="brand">✳ WayCode</span>
    <span id="status" class="status"></span>
  </header>
  <div id="messages" class="messages"></div>
  <div class="composer">
    <div id="chips" class="chips"></div>
    <textarea id="input" rows="3" placeholder="Ask WayCode…  (Enter to send, Shift+Enter = newline)"></textarea>
    <div class="composer-actions">
      <button id="addContext" class="toggle" title="Attach files as context">➕</button>
      <button id="historyBtn" class="toggle" title="Conversation history">🕘</button>
      <button id="settingsBtn" class="toggle" title="WayCode settings">⚙</button>
      <div class="mode-wrap">
        <button id="modeBtn" class="toggle" title="Switch mode (Shift+Tab)">⚡ Mode ▾</button>
        <div id="modeMenu" class="mode-menu hidden"></div>
      </div>
      <span class="spacer"></span>
      <button id="newTask" title="Start a new task">New task</button>
      <button id="send" class="primary">Send</button>
      <button id="cancel" class="hidden">Stop</button>
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
    this.controller.bind(view.webview);
  }

  reveal(): void {
    this.view?.show?.(true);
  }
}

/** Open (or focus) the full-window editor-tab chat, sharing the same controller. */
let panel: vscode.WebviewPanel | undefined;
export function openChatPanel(extensionUri: vscode.Uri, controller: ChatController): void {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel(
    "waycode.chatPanel",
    "WayCode",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
  controller.bind(panel.webview);
  panel.onDidDispose(() => {
    if (panel) controller.unbind(panel.webview);
    panel = undefined;
  });
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
