import * as vscode from "vscode";
import { Agent, AgentEvents } from "../agent/Agent";
import { Orchestrator, RoleModel } from "../agent/Orchestrator";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ProjectContext } from "../context/ProjectContext";
import { Memory } from "../memory/Memory";
import { Config, AgentRole } from "../config";
import { createProvider, PROVIDER_META, ProviderId } from "../providers/ProviderFactory";
import { ToolPreview } from "../tools/Tool";

/** Anything the chat can drive: a single Agent or the multi-agent Orchestrator. */
interface Runner {
  cancel(): void;
  reset(): void;
  run(userMessage: string, events: AgentEvents): Promise<unknown>;
}

/** Hosts the chat webview and wires it to the Agent engine. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "waycode.chatView";

  private view?: vscode.WebviewView;
  private runner?: Runner;
  /** Signature of the config the current runner was built with. */
  private runnerSig?: string;
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  private approvalSeq = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memory: Memory,
    private readonly config: Config
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case "send":
          await this.handleSend(String(msg.text ?? ""));
          break;
        case "approval":
          this.resolveApproval(String(msg.id), Boolean(msg.approved));
          break;
        case "cancel":
          this.runner?.cancel();
          break;
        case "newTask":
          this.runner?.reset();
          this.post({ type: "cleared" });
          break;
        case "ready":
          this.post({ type: "status", text: this.statusLine() });
          break;
      }
    });
  }

  /** Public entry used by commands. */
  reveal(): void {
    this.view?.show?.(true);
  }

  focusInput(): void {
    this.post({ type: "focusInput" });
  }

  /** Pre-fill the composer with text (e.g. a code selection) for the user to extend. */
  prefill(text: string): void {
    this.view?.show?.(true);
    this.post({ type: "prefill", text });
  }

  notify(text: string): void {
    this.post({ type: "log", text });
  }

  private statusLine(): string {
    const approval = `  ·  🔓 ${this.config.approvalModeLabel}`;
    const lang = this.config.language !== "auto" ? `  ·  🌐 ${this.config.language}` : "";
    if (this.config.multiAgentEnabled) {
      const comm = this.config.roleModel("communicator");
      const coder = this.config.roleModel("coder");
      return `🗣️ ${comm}  →  👨‍💻 ${coder}${approval}${lang}`;
    }
    const p = this.config.provider;
    return `${PROVIDER_META[p].label} · ${this.config.model}${approval}${lang}`;
  }

  /** Build a role's provider instance, validating that its API key exists. */
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

  /** Identity of the current model/mode/config; a change forces a fresh runner. */
  private runnerSignature(root: string): string {
    const c = this.config;
    const approval = `${c.autoApproveReads}/${c.autoApproveFileEdits}/${c.autoApproveCommands}`;
    const common = `${root}|${c.language}|${approval}|${c.maxAgentSteps}`;
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
      autoApproveReads: this.config.autoApproveReads,
      autoApproveWrites: this.config.autoApproveFileEdits,
      autoApproveCommands: this.config.autoApproveCommands,
      language: this.config.language,
    };
  }

  /** Construct the active runner (single Agent or multi-agent Orchestrator). */
  private async buildRunner(root: string): Promise<Runner | undefined> {
    const cfg = this.agentConfig();
    if (this.config.multiAgentEnabled) {
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

  private async handleSend(text: string): Promise<void> {
    if (!text.trim()) return;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: "error", text: "Open a folder/workspace first." });
      return;
    }
    const root = folder.uri.fsPath;

    // Reuse the same runner across turns so the conversation keeps its history;
    // rebuild only when the model/mode/config actually changed.
    const signature = this.runnerSignature(root);
    if (!this.runner || signature !== this.runnerSig) {
      const built = await this.buildRunner(root);
      if (!built) return; // an error was already posted
      this.runner = built;
      this.runnerSig = signature;
    }

    this.post({ type: "userMessage", text });
    this.post({ type: "running", value: true });

    const events: AgentEvents = {
      onAssistantText: (t) => this.post({ type: "assistant", text: t }),
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
      onDone: () => this.post({ type: "running", value: false }),
      onPhase: (name, label) => this.post({ type: "phase", name, label }),
    };

    await this.runner.run(text, events);
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
    this.view?.webview.postMessage(message);
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
  <div id="status" class="status"></div>
  <div id="messages" class="messages"></div>
  <div class="composer">
    <textarea id="input" rows="3" placeholder="Ask WayCode… (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="composer-actions">
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

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
