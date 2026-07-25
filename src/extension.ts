import * as vscode from "vscode";
import { ChatViewProvider, ChatController, openChatPanel } from "./ui/ChatViewProvider";
import { openSettingsPanel } from "./ui/SettingsPanel";
import { contextFilePath, CONTEXT_TEMPLATE } from "./context/contextFile";
import { History } from "./memory/History";
import { Memory } from "./memory/Memory";
import { Config } from "./config";
import { ProviderId, PROVIDER_META } from "./providers/ProviderFactory";
import { toRelative } from "./tools/pathUtils";

export function activate(context: vscode.ExtensionContext): void {
  const memory = new Memory(context.workspaceState);
  const config = new Config(context.secrets);
  const history = new History(context.globalState);
  const controller = new ChatController(context.extensionUri, memory, config, history);
  const chat = new ChatViewProvider(controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("waycode.openChat", async () => {
      await vscode.commands.executeCommand("waycode.chatView.focus");
      controller.focusInput();
    }),

    vscode.commands.registerCommand("waycode.openPanel", () => openChatPanel(context.extensionUri, controller)),

    vscode.commands.registerCommand("waycode.openSettings", () => openSettingsPanel(context.extensionUri, config)),

    vscode.commands.registerCommand("waycode.history", () => controller.openHistory()),

    vscode.commands.registerCommand("waycode.editContext", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showWarningMessage("WayCode: open a folder first.");
        return;
      }
      const uri = vscode.Uri.file(contextFilePath(folder.uri.fsPath));
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(CONTEXT_TEMPLATE, "utf8"));
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }),

    vscode.commands.registerCommand("waycode.newTask", async () => {
      await vscode.commands.executeCommand("waycode.chatView.focus");
      chat.reveal();
      controller.notify("Started a new task.");
    }),

    vscode.commands.registerCommand("waycode.addFileToContext", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!target || !folder) {
        vscode.window.showWarningMessage("WayCode: no file selected.");
        return;
      }
      const rel = toRelative(folder.uri.fsPath, target.fsPath);
      await vscode.commands.executeCommand("waycode.chatView.focus");
      controller.attachContext(rel);
    }),

    vscode.commands.registerCommand("waycode.selectModel", () => selectModel(config, controller)),

    vscode.commands.registerCommand("waycode.setApiKey", () => setApiKey(config)),

    vscode.commands.registerCommand("waycode.configureRoles", () => configureRoles(config, controller)),

    vscode.commands.registerCommand("waycode.setApprovalMode", () => setApprovalMode(config, controller)),

    vscode.commands.registerCommand("waycode.selectLanguage", () => selectLanguage(config, controller)),

    vscode.commands.registerCommand("waycode.askSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage("WayCode: select some code first.");
        return;
      }
      const selection = editor.document.getText(editor.selection);
      const folder = vscode.workspace.workspaceFolders?.[0];
      const rel = folder
        ? toRelative(folder.uri.fsPath, editor.document.uri.fsPath)
        : editor.document.fileName;
      const startLine = editor.selection.start.line + 1;
      const lang = editor.document.languageId;
      const block = `About \`${rel}:${startLine}\`:\n\n\`\`\`${lang}\n${selection}\n\`\`\`\n\n`;
      await vscode.commands.executeCommand("waycode.chatView.focus");
      controller.prefill(block);
    })
  );
}

async function selectLanguage(config: Config, chat: ChatController): Promise<void> {
  const languages = [
    "auto",
    "Hebrew",
    "English",
    "Arabic",
    "Russian",
    "Spanish",
    "French",
    "German",
    "Portuguese",
    "Chinese",
  ];
  const pick = await vscode.window.showQuickPick(
    languages.map((l) => ({
      label: l === "auto" ? "Auto (match my language)" : l,
      value: l,
      description: l === config.language ? "current" : "",
    })),
    { title: "WayCode: Reply language" }
  );
  if (!pick) return;
  await config.setLanguage(pick.value);
  chat.notify(`🌐 Reply language: ${pick.label}`);
  vscode.window.showInformationMessage(`WayCode will reply in: ${pick.label}.`);
}

async function setApprovalMode(config: Config, chat: ChatController): Promise<void> {
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

async function configureRoles(config: Config, chat: ChatController): Promise<void> {
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

    const model = await pickModel(config, providerPick.id, config.roleModel(role));
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

async function selectModel(config: Config, chat: ChatController): Promise<void> {
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

  const model = await pickModel(config, providerPick.id, config.model);
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

/** Fetch the list of models installed in a local Ollama server. */
async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
  } catch {
    return [];
  }
}

/**
 * Pick a model id. For Ollama we offer the installed models directly (with a
 * "type manually" escape hatch); for other providers we fall back to text input.
 */
async function pickModel(
  config: Config,
  providerId: ProviderId,
  currentModel: string
): Promise<string | undefined> {
  if (providerId === "ollama") {
    const models = await fetchOllamaModels(config.ollamaBaseUrl);
    if (models.length) {
      const MANUAL = "✏️ Type a model name…";
      const pick = await vscode.window.showQuickPick(
        [
          ...models.map((m) => ({ label: m, description: m === currentModel ? "current" : "" })),
          { label: MANUAL, description: "" },
        ],
        { title: "WayCode: Select an installed Ollama model" }
      );
      if (!pick) return undefined;
      if (pick.label !== MANUAL) return pick.label;
    }
  }
  return vscode.window.showInputBox({
    title: `Model id (${PROVIDER_META[providerId].label})`,
    value: currentModel || PROVIDER_META[providerId].defaultModel,
    prompt: "Enter the model id to use.",
  });
}

export function deactivate(): void {
  /* nothing to clean up */
}
