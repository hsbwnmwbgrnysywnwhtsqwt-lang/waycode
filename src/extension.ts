import * as vscode from "vscode";
import { ChatViewProvider, ChatController, openChatPanel } from "./ui/ChatViewProvider";
import { openSettingsPanel } from "./ui/SettingsPanel";
import { contextFilePath, CONTEXT_TEMPLATE } from "./context/contextFile";
import { History } from "./memory/History";
import { Memory } from "./memory/Memory";
import { Config, AgentRole } from "./config";
import { ProviderId, PROVIDER_META } from "./providers/ProviderFactory";
import {
  coderHardwareAdvice,
  fetchOllamaModels,
  fitIcon,
  formatSpecs,
  OllamaModelInfo,
  RECOMMENDED_CODERS,
} from "./providers/ollamaModels";
import { toRelative } from "./tools/pathUtils";

export function activate(context: vscode.ExtensionContext): void {
  const memory = new Memory(context.workspaceState);
  const config = new Config(context.secrets);
  const history = new History(context.globalState);
  // Per-conversation context files live beside the extension's other state, so
  // they survive reloads without adding noise to the user's repository.
  const notesDir = vscode.Uri.joinPath(context.globalStorageUri, "conversations").fsPath;
  const controller = new ChatController(context.extensionUri, memory, config, history, notesDir);
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

    vscode.commands.registerCommand("waycode.openSessionContext", () =>
      controller.openSessionContextFile()
    ),

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
      // Actually clear the thread — announcing it is not the same as doing it.
      await controller.newTask();
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

    const model = await pickModel(config, providerPick.id, config.roleModel(role), role);
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

  // The single agent does the editing itself, so it is held to the coder bar.
  const model = await pickModel(config, providerPick.id, config.model, "coder");
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

/**
 * Pick a model id. For Ollama we scan the machine and show what is installed,
 * annotated with size, parameter count, context window and — most usefully —
 * whether the model can actually drive the tools. For other providers we fall
 * back to text input.
 */
async function pickModel(
  config: Config,
  providerId: ProviderId,
  currentModel: string,
  role?: AgentRole
): Promise<string | undefined> {
  if (providerId === "ollama") {
    const models = await fetchOllamaModels(config.ollamaBaseUrl);
    if (models.length) {
      const MANUAL = "✏️ Type a model name…";
      const pick = await vscode.window.showQuickPick(
        [
          ...models.map((m) => ({
            label: `${fitIcon(m.coderFit)}  ${m.name}`,
            description: m.name === currentModel ? "current" : "",
            detail: `${formatSpecs(m)}  —  ${m.note}`,
            name: m.name,
            info: m,
          })),
          { label: MANUAL, description: "", detail: "", name: MANUAL, info: undefined },
        ],
        {
          title:
            role === "coder"
              ? "WayCode: Ollama model for the CODER role (must be able to call tools)"
              : "WayCode: Select an installed Ollama model",
          matchOnDetail: true,
        }
      );
      if (!pick) return undefined;
      if (pick.name !== MANUAL) {
        if (pick.info && role === "coder") await warnIfPoorCoder(pick.info);
        return pick.name;
      }
    } else {
      vscode.window.showWarningMessage(
        `WayCode: no Ollama models found at ${config.ollamaBaseUrl}. Is Ollama running? Type a model id manually, or run 'ollama pull <model>' first.`
      );
    }
  }
  return vscode.window.showInputBox({
    title: `Model id (${PROVIDER_META[providerId].label})`,
    value: currentModel || PROVIDER_META[providerId].defaultModel,
    prompt: "Enter the model id to use.",
  });
}

/**
 * Tell the user up front when the model they picked cannot do the coder's job —
 * a silent "nothing happened" run is far more confusing than this message.
 */
async function warnIfPoorCoder(m: OllamaModelInfo): Promise<void> {
  if (m.coderFit === "good") return;
  const detail = m.supportsTools
    ? `${m.name} (${m.parameterSize ?? "small"}) is below the size where models reliably produce valid tool calls. Expect it to read files, describe a plan, and change nothing.`
    : `${m.name} does not support tool calling at all, so it cannot read or edit files. It can only be the communicator.`;
  const advice = coderHardwareAdvice();
  const recommend = "Show stronger models";
  const choice = await vscode.window.showWarningMessage(
    `WayCode: ${detail}`,
    recommend,
    "Use anyway"
  );
  if (choice !== recommend) return;

  const items = RECOMMENDED_CODERS.map((r) => ({
    label: `$(rocket) ${r.name}`,
    description: `~${r.downloadGB}GB download · needs ~${r.needsRamGB}GB RAM`,
    detail: r.why,
  }));
  await vscode.window.showQuickPick(items, {
    title: "WayCode: local models strong enough for the coder role",
    placeHolder: advice ?? "Install one with:  ollama pull <name>",
    matchOnDetail: true,
  });
  if (advice) vscode.window.showInformationMessage(`WayCode: ${advice}`);
}

export function deactivate(): void {
  /* nothing to clean up */
}
