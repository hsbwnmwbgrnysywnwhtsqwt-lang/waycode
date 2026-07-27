import * as fs from "fs/promises";
import * as path from "path";

/** What one completed turn contributed to the conversation's context file. */
export interface TurnNote {
  /** What the user asked for, in their own words. */
  request: string;
  /** GROUND TRUTH lines — the tools that actually ran (see agent/actions.ts). */
  actions: string[];
  /** The reply the user was actually shown. */
  result: string;
  /** Defaults to now; injectable for tests. */
  ts?: number;
}

export const NOTES_HEADER = `# WayCode conversation context

<!-- Auto-maintained by WayCode. Both the language bot and the coder read this
     file at the start of every turn, so the conversation keeps its context
     across reloads and when it is reopened from the history. -->
`;

/** Keep the file (and therefore the prompt block) bounded. */
const MAX_CHARS = 12_000;
const MAX_REQUEST = 600;
const MAX_RESULT = 900;
const MAX_ACTIONS = 25;

/**
 * A per-conversation context file: one markdown file per chat session, holding
 * a compact record of every turn — what was asked, which tools really ran, and
 * what the user was told.
 *
 * This is what makes a restored conversation actually *restored*: the model's
 * in-memory history dies with the extension host, but this file does not, so
 * both bots start a reopened conversation knowing what already happened.
 */
export class SessionNotes {
  /** Mirrors the file so the common read-per-turn path costs no disk I/O. */
  private cache?: string;

  constructor(private readonly dir: string, readonly sessionId: string) {}

  filePath(): string {
    return path.join(this.dir, `${this.sessionId}.md`);
  }

  async read(): Promise<string> {
    if (this.cache === undefined) {
      try {
        this.cache = await fs.readFile(this.filePath(), "utf8");
      } catch {
        this.cache = "";
      }
    }
    return this.cache;
  }

  /** The notes formatted for a system prompt — empty while nothing has happened. */
  async render(): Promise<string> {
    const body = stripHeader(await this.read()).trim();
    if (!body) return "";
    return `# Conversation context so far (earlier turns of THIS conversation)
These turns already happened. Treat them as fact — do not redo work that is
already recorded as done, and do not claim work that is not recorded here.

${body}`;
  }

  /** Append one finished turn and persist. Never throws — notes are best-effort. */
  async appendTurn(note: TurnNote): Promise<void> {
    try {
      const existing = (await this.read()) || NOTES_HEADER;
      const next = trimToTail(existing + formatTurn(note, nextTurnNumber(existing)));
      this.cache = next;
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.filePath(), next, "utf8");
    } catch {
      /* a context file we cannot write must never break the chat */
    }
  }
}

export function formatTurn(note: TurnNote, index: number): string {
  const when = new Date(note.ts ?? Date.now()).toISOString().replace("T", " ").slice(0, 16);
  const actions = note.actions.slice(0, MAX_ACTIONS);
  const lines = [
    "",
    `## Turn ${index} — ${when}`,
    `**User asked:** ${clip(note.request, MAX_REQUEST)}`,
    actions.length
      ? `**Tools that actually ran:**\n${actions.map((a) => `- ${a}`).join("\n")}`
      : `**Tools that actually ran:** none — nothing was changed.`,
    `**Answer given:** ${clip(note.result, MAX_RESULT)}`,
    "",
  ];
  return lines.join("\n");
}

/** Number of `## Turn N` sections already recorded. */
export function countTurns(md: string): number {
  return (md.match(/^## Turn \d+/gm) ?? []).length;
}

/**
 * The number to give the next turn: one past the HIGHEST recorded so far, not
 * one past the count. Once trimming has dropped old turns the two differ, and
 * counting produced a file with two "## Turn 6" sections — which then reads to
 * the model as the same turn happening twice.
 */
export function nextTurnNumber(md: string): number {
  const numbers = [...md.matchAll(/^## Turn (\d+)/gm)].map((m) => Number(m[1]));
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

/** Everything after the header comment block. */
export function stripHeader(md: string): string {
  const i = md.indexOf("## Turn ");
  return i === -1 ? "" : md.slice(i);
}

/**
 * Drop the OLDEST turns until the file fits, keeping the header. Recent turns
 * are what a follow-up request depends on, so the tail is what we protect.
 */
export function trimToTail(md: string, maxChars = MAX_CHARS): string {
  if (md.length <= maxChars) return md;
  const turns = stripHeader(md).split(/(?=^## Turn \d+)/m).filter(Boolean);
  const kept: string[] = [];
  let size = NOTES_HEADER.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (size + turns[i].length > maxChars && kept.length) break;
    kept.unshift(turns[i]);
    size += turns[i].length;
  }
  return NOTES_HEADER + "\n<!-- older turns trimmed -->\n" + kept.join("");
}

function clip(s: string, max: number): string {
  const t = (s || "").trim().replace(/\n{3,}/g, "\n\n");
  return t.length > max ? t.slice(0, max) + " […]" : t || "(nothing)";
}
