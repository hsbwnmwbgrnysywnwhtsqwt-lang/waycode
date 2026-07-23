import * as vscode from "vscode";
import { ProviderId, PROVIDER_META } from "./providers/ProviderFactory";
import { ProviderCredentials } from "./providers/types";

const SECRET_PREFIX = "waycode.apiKey.";

/** The two roles in the multi-agent pipeline. */
export type AgentRole = "communicator" | "coder";

/** Centralised access to WayCode settings and secret API keys. */
export class Config {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get provider(): ProviderId {
    return vscode.workspace.getConfiguration("waycode").get<ProviderId>("provider", "anthropic");
  }

  get model(): string {
    const configured = vscode.workspace.getConfiguration("waycode").get<string>("model", "");
    return configured || PROVIDER_META[this.provider].defaultModel;
  }

  get maxAgentSteps(): number {
    return vscode.workspace.getConfiguration("waycode").get<number>("maxAgentSteps", 25);
  }

  get autoApproveReads(): boolean {
    return vscode.workspace.getConfiguration("waycode").get<boolean>("autoApproveReads", true);
  }

  get multiAgentEnabled(): boolean {
    return vscode.workspace.getConfiguration("waycode").get<boolean>("multiAgent.enabled", false);
  }

  /** Provider for a role, falling back to the base provider when unset. */
  roleProvider(role: AgentRole): ProviderId {
    const raw = vscode.workspace
      .getConfiguration("waycode")
      .get<string>(`roles.${role}.provider`, "");
    return (raw as ProviderId) || this.provider;
  }

  /** Model for a role, falling back to the provider's default model when unset. */
  roleModel(role: AgentRole): string {
    const configured = vscode.workspace
      .getConfiguration("waycode")
      .get<string>(`roles.${role}.model`, "");
    if (configured) return configured;
    const provider = this.roleProvider(role);
    // If the role uses the base provider, honour the base model too.
    if (provider === this.provider) return this.model;
    return PROVIDER_META[provider].defaultModel;
  }

  async setRole(role: AgentRole, provider: ProviderId, model: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("waycode");
    await cfg.update(`roles.${role}.provider`, provider, vscode.ConfigurationTarget.Global);
    await cfg.update(`roles.${role}.model`, model, vscode.ConfigurationTarget.Global);
  }

  async setMultiAgentEnabled(enabled: boolean): Promise<void> {
    await vscode.workspace
      .getConfiguration("waycode")
      .update("multiAgent.enabled", enabled, vscode.ConfigurationTarget.Global);
  }

  get ollamaBaseUrl(): string {
    return vscode.workspace.getConfiguration("waycode").get<string>("ollama.baseUrl", "http://localhost:11434");
  }

  async setProvider(id: ProviderId): Promise<void> {
    await vscode.workspace
      .getConfiguration("waycode")
      .update("provider", id, vscode.ConfigurationTarget.Global);
  }

  async setModel(model: string): Promise<void> {
    await vscode.workspace
      .getConfiguration("waycode")
      .update("model", model, vscode.ConfigurationTarget.Global);
  }

  async getApiKey(id: ProviderId): Promise<string | undefined> {
    return this.secrets.get(SECRET_PREFIX + id);
  }

  async setApiKey(id: ProviderId, key: string): Promise<void> {
    await this.secrets.store(SECRET_PREFIX + id, key);
  }

  /** Build the credentials object for the active provider. */
  async credentialsFor(id: ProviderId): Promise<ProviderCredentials> {
    const creds: ProviderCredentials = {};
    if (PROVIDER_META[id].requiresApiKey) {
      creds.apiKey = await this.getApiKey(id);
    }
    if (id === "ollama") {
      creds.baseUrl = this.ollamaBaseUrl;
    }
    return creds;
  }
}
