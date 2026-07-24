import * as vscode from "vscode";
import { ChatViewProvider } from "./ui/ChatViewProvider";
import { Memory } from "./memory/Memory";
import { Config } from "./config";
import { ProviderId, PROVIDER_META } from "./providers/ProviderFactory";
import { toRelative } from "./tools/pathUtils";

export function activate(context: vscode.ExtensionContext): void {
  const memory = new Memory(context.workspaceState);
  const config = new Config(context.secrets);
  const chat = new ChatViewProvider(context.extensionUri, memory, config);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("waycode.openChat", async () => {
      await vscode.commands.executeCommand("waycode.chatView.focus");
      chat.focusInput();
    }),

    vscode.commands.registerCommand("waycode.newTask", async () => {
      await vscode.commands.executeCommand("waycode.chatView.focus");
      chat.reveal();
      chat.notify("Started a new task.");
    }),

    vscode.commands.registerCommand("waycode.addFileToContext", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!target || !folder) {
        vscode.window.showWarningMessage("WayCode: no file selected.");
        return;
      }
      const rel = toRelative(folder.uri.fsPath, target.fsPath);
      await memory.pinFile(rel);
      await vscode.commands.executeCommand("waycode.chatView.focus");
      chat.notify(`📌 Added ${rel} to context.`);
    }),

    vscode.commands.registerCommand("waycode.selectModel", () => selectModel(config, chat)),

    vscode.commands.registerCommand("waycode.setApiKey", () => setApiKey(config)),

    vscode.commands.registerCommand("waycode.configureRoles", () => configureRoles(config, chat)),

    vscode.commands.registerCommand("waycode.setApprovalMode", () => setApprovalMode(config, chat))
  );
}

async function setApprovalMode(config: Config, chat: ChatViewProvider): Promise<void> {
  const presets = [
    {
      label: "$(shield) Ask for everything",
      detail: "Even reading files needs approval (strictest).",
      mode: { reads: false, fileEdits: false, commands: false },
    },
    {
      label: "$(eye) Auto-approve reads only",
      detail: "Reading/searching files is automatic; edits and commands still ask. (default)",
      mode: { reads: true, fileEdits: false, commands: false },
    },
    {
      label: "$(edit) Auto-approve file edits",
      detail: "File create/edit/write happen automatically; commands still ask.",
      mode: { reads: true, fileEdits: true, commands: false },
    },
    {
      label: "$(terminal) Auto-approve commands",
      detail: "Terminal/git/test/lint run automatically; file edits still ask.",
      mode: { reads: true, fileEdits: false, commands: true },
    },
    {
      label: "$(rocket) Auto-approve everything (YOLO)",
      detail: "Nothing asks for approval. Use only when you fully trust the agent.",
      mode: { reads: true, fileEdits: true, commands: true },
    },
  ];
  const pick = await vscode.window.showQuickPick(
    presets.map((p) => ({ label: p.label, detail: p.detail, mode: p.mode })),
    { title: "WayCode: Approval mode", matchOnDetail: true }
  );
  if (!pick) return;
  await config.setApprovalMode(pick.mode);
  chat.notify(`🔓 Approval mode: ${config.approvalModeLabel}`);
  vscode.window.showInformationMessage(`WayCode approval mode: ${config.approvalModeLabel}.`);
}

async function configureRoles(config: Config, chat: ChatViewProvider): Promise<void> {
  const enablePick = await vscode.window.showQuickPick(
    [
      { label: "Enable multi-agent (communicator + coder)", value: true },
      { label: "Disable (single agent)", value: false },
    ],
    { title: "WayCode: Multi-agent pipeline" }
  );
  if (!enablePick) return;
  await config.setMultiAgentEnabled(enablePick.value);

  if (!enablePick.value) {
    chat.notify("Switched to single-agent mode.");
    vscode.window.showInformationMessage("WayCode: single-agent mode.");
    return;
  }

  for (const role of ["communicator", "coder"] as const) {
    const hint =
      role === "communicator"
        ? "Model that talks to you (strong at natural language / Hebrew)"
        : "Model that writes code (strong at code; need not speak your language)";
    const providerPick = await vscode.window.showQuickPick(
      (Object.keys(PROVIDER_META) as ProviderId[]).map((id) => ({
        label: PROVIDER_META[id].label,
        description: id === config.roleProvider(role) ? "current" : "",
        id,
      })),
      { title: `WayCode: ${role.toUpperCase()} provider — ${hint}` }
    );
    if (!providerPick) return;

    const model = await vscode.window.showInputBox({
      title: `${role.toUpperCase()} model (${providerPick.label})`,
      value: config.roleModel(role) || PROVIDER_META[providerPick.id].defaultModel,
      prompt: hint,
    });
    if (model === undefined) return;
    await config.setRole(role, providerPick.id, model);

    if (PROVIDER_META[providerPick.id].requiresApiKey && !(await config.getApiKey(providerPick.id))) {
      await setApiKey(config, providerPick.id);
    }
  }

  chat.notify(
    `Multi-agent ready: 🗣️ ${config.roleModel("communicator")} → 👨‍💻 ${config.roleModel("coder")}`
  );
  vscode.window.showInformationMessage("WayCode: multi-agent pipeline configured.");
}

async function selectModel(config: Config, chat: ChatViewProvider): Promise<void> {
  const providerPick = await vscode.window.showQuickPick(
    (Object.keys(PROVIDER_META) as ProviderId[]).map((id) => ({
      label: PROVIDER_META[id].label,
      description: id === config.provider ? "current" : "",
      id,
    })),
    { title: "WayCode: Select provider" }
  );
  if (!providerPick) return;
  await config.setProvider(providerPick.id);

  const model = await vscode.window.showInputBox({
    title: `Model for ${providerPick.label}`,
    value: PROVIDER_META[providerPick.id].defaultModel,
    prompt: "Enter the model id to use.",
  });
  if (model) {
    await config.setModel(model);
  }

  if (PROVIDER_META[providerPick.id].requiresApiKey && !(await config.getApiKey(providerPick.id))) {
    const set = await vscode.window.showInformationMessage(
      `No API key set for ${providerPick.label}. Set one now?`,
      "Set API Key"
    );
    if (set) await setApiKey(config, providerPick.id);
  }

  chat.notify(`Switched to ${providerPick.label} · ${config.model}`);
  vscode.window.showInformationMessage(`WayCode: using ${providerPick.label} (${config.model}).`);
}

async function setApiKey(config: Config, preselected?: ProviderId): Promise<void> {
  let id = preselected;
  if (!id) {
    const pick = await vscode.window.showQuickPick(
      (Object.keys(PROVIDER_META) as ProviderId[])
        .filter((p) => PROVIDER_META[p].requiresApiKey)
        .map((p) => ({ label: PROVIDER_META[p].label, id: p })),
      { title: "WayCode: Set API key for which provider?" }
    );
    if (!pick) return;
    id = pick.id;
  }
  const key = await vscode.window.showInputBox({
    title: `${PROVIDER_META[id].label} API key`,
    password: true,
    ignoreFocusOut: true,
    prompt: "Stored securely in VS Code Secret Storage.",
  });
  if (key) {
    await config.setApiKey(id, key);
    vscode.window.showInformationMessage(`WayCode: API key saved for ${PROVIDER_META[id].label}.`);
  }
}

export function deactivate(): void {
  /* nothing to clean up */
}
