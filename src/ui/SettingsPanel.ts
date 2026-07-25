import * as vscode from "vscode";
import { Config, AgentRole } from "../config";
import { PROVIDER_META, ProviderId } from "../providers/ProviderFactory";

const LANGUAGES = [
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

let panel: vscode.WebviewPanel | undefined;

/** Open (or focus) the WayCode settings page — a full webview form. */
export function openSettingsPanel(extensionUri: vscode.Uri, config: Config): void {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel("waycode.settings", "WayCode Settings", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
  });
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
  const view = panel.webview;
  view.html = html(view, extensionUri);

  const sendInit = async () => {
    view.postMessage({ type: "init", data: await collect(config) });
  };

  view.onDidReceiveMessage(async (msg) => {
    switch (msg?.type) {
      case "ready":
        await sendInit();
        break;
      case "save":
        await save(config, msg.data);
        await sendInit();
        vscode.window.showInformationMessage("WayCode settings saved.");
        break;
      case "setKey": {
        const id = String(msg.provider) as ProviderId;
        const key = await vscode.window.showInputBox({
          title: `${PROVIDER_META[id].label} API key`,
          password: true,
          ignoreFocusOut: true,
          prompt: "Stored securely in VS Code Secret Storage.",
        });
        if (key) await config.setApiKey(id, key);
        await sendInit();
        break;
      }
      case "clearKey": {
        const id = String(msg.provider) as ProviderId;
        await config.setApiKey(id, "");
        await sendInit();
        break;
      }
    }
  });

  panel.onDidDispose(() => {
    panel = undefined;
  });
}

async function collect(config: Config) {
  const providers = (Object.keys(PROVIDER_META) as ProviderId[]).map((id) => ({
    id,
    label: PROVIDER_META[id].label,
    requiresApiKey: PROVIDER_META[id].requiresApiKey,
    defaultModel: PROVIDER_META[id].defaultModel,
  }));
  const keys: Record<string, boolean> = {};
  for (const p of providers) {
    if (p.requiresApiKey) keys[p.id] = Boolean(await config.getApiKey(p.id));
  }
  return {
    providers,
    languages: LANGUAGES,
    provider: config.provider,
    model: config.model,
    language: config.language,
    multiAgent: config.multiAgentEnabled,
    roles: {
      communicator: { provider: config.roleProvider("communicator"), model: config.roleModel("communicator") },
      coder: { provider: config.roleProvider("coder"), model: config.roleModel("coder") },
    },
    approval: {
      reads: config.autoApproveReads,
      fileEdits: config.autoApproveFileEdits,
      commands: config.autoApproveCommands,
    },
    ollamaBaseUrl: config.ollamaBaseUrl,
    openaiBaseUrl: config.openaiBaseUrl,
    ollamaModels: await fetchOllamaModels(config.ollamaBaseUrl),
    keys,
  };
}

async function save(config: Config, data: any): Promise<void> {
  await config.setProvider(data.provider);
  await config.setModel(String(data.model ?? "").trim());
  await config.setLanguage(data.language);
  await config.setMultiAgentEnabled(Boolean(data.multiAgent));
  for (const role of ["communicator", "coder"] as AgentRole[]) {
    const r = data.roles?.[role] ?? {};
    await config.setRole(role, (r.provider ?? "") as ProviderId, String(r.model ?? "").trim());
  }
  await config.setApprovalMode({
    reads: Boolean(data.approval?.reads),
    fileEdits: Boolean(data.approval?.fileEdits),
    commands: Boolean(data.approval?.commands),
  });
  await config.setOllamaBaseUrl(String(data.ollamaBaseUrl ?? "").trim());
  await config.setOpenaiBaseUrl(String(data.openaiBaseUrl ?? "").trim());
}

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

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "settings.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "settings.css"));
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
  <title>WayCode Settings</title>
</head>
<body>
  <div class="wrap">
    <header><span class="brand">✳ WayCode</span><span class="sub">Settings</span></header>
    <div id="form"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
