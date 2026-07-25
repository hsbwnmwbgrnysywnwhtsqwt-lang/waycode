import * as vscode from "vscode";

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Session {
  id: string;
  title: string;
  ts: number;
  workspace: string;
  messages: SessionMessage[];
}

const KEY = "waycode.sessions";
const MAX_SESSIONS = 50;

/**
 * Persistent, per-workspace conversation history. Stored in global state, keyed
 * by workspace path so each project has its own list.
 */
export class History {
  constructor(private readonly storage: vscode.Memento) {}

  private all(): Session[] {
    return this.storage.get<Session[]>(KEY, []);
  }

  /** Sessions for a workspace, newest first (empty ones excluded). */
  list(workspace: string): Session[] {
    return this.all()
      .filter((s) => s.workspace === workspace && s.messages.length > 0)
      .sort((a, b) => b.ts - a.ts);
  }

  get(id: string): Session | undefined {
    return this.all().find((s) => s.id === id);
  }

  async save(session: Session): Promise<void> {
    if (!session.messages.length) return;
    const others = this.all().filter((s) => s.id !== session.id);
    others.push(session);
    others.sort((a, b) => b.ts - a.ts);
    await this.storage.update(KEY, others.slice(0, MAX_SESSIONS));
  }

  async delete(id: string): Promise<void> {
    await this.storage.update(KEY, this.all().filter((s) => s.id !== id));
  }

  static newSession(workspace: string): Session {
    return {
      id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: "",
      ts: Date.now(),
      workspace,
      messages: [],
    };
  }
}
