import * as vscode from "vscode";

export interface MemoryState {
  /** Files the user explicitly pinned into context. */
  pinnedFiles: string[];
  /** Durable decisions/notes the agent recorded during work. */
  decisions: string[];
  /** Free-form user preferences (coding style, language, etc.). */
  preferences: string[];
}

const KEY = "waycode.memory";

/**
 * Persistent, per-workspace memory. Stored in VS Code's workspaceState so it
 * survives reloads. Keeps track of project decisions, pinned files, and user
 * preferences that should inform every future task.
 */
export class Memory {
  private state: MemoryState;

  constructor(private readonly storage: vscode.Memento) {
    this.state = storage.get<MemoryState>(KEY) ?? {
      pinnedFiles: [],
      decisions: [],
      preferences: [],
    };
  }

  get(): MemoryState {
    return this.state;
  }

  async pinFile(relPath: string): Promise<void> {
    if (!this.state.pinnedFiles.includes(relPath)) {
      this.state.pinnedFiles.push(relPath);
      await this.persist();
    }
  }

  async unpinFile(relPath: string): Promise<void> {
    this.state.pinnedFiles = this.state.pinnedFiles.filter((f) => f !== relPath);
    await this.persist();
  }

  async recordDecision(text: string): Promise<void> {
    this.state.decisions.push(text);
    if (this.state.decisions.length > 50) {
      this.state.decisions = this.state.decisions.slice(-50);
    }
    await this.persist();
  }

  async recordPreference(text: string): Promise<void> {
    if (!this.state.preferences.includes(text)) {
      this.state.preferences.push(text);
      await this.persist();
    }
  }

  async clear(): Promise<void> {
    this.state = { pinnedFiles: [], decisions: [], preferences: [] };
    await this.persist();
  }

  /** Render memory as a compact block for the system prompt. */
  render(): string {
    const s = this.state;
    if (!s.pinnedFiles.length && !s.decisions.length && !s.preferences.length) {
      return "";
    }
    const parts: string[] = ["# Project Memory"];
    if (s.pinnedFiles.length) parts.push(`Pinned files:\n- ${s.pinnedFiles.join("\n- ")}`);
    if (s.preferences.length) parts.push(`User preferences:\n- ${s.preferences.join("\n- ")}`);
    if (s.decisions.length) parts.push(`Past decisions:\n- ${s.decisions.slice(-15).join("\n- ")}`);
    return parts.join("\n\n");
  }

  private async persist(): Promise<void> {
    await this.storage.update(KEY, this.state);
  }
}
