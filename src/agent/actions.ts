import { ToolCall, ToolResult } from "../providers/types";

/** Tools that change files on disk. */
export const WRITE_TOOLS = new Set(["create_file", "write_file", "edit_file"]);

/** Tools that execute something (and therefore can verify). */
export const COMMAND_TOOLS = new Set(["run_terminal", "run_tests", "run_linter", "git"]);

/**
 * One line of GROUND TRUTH: what a tool call actually did. Shared by the
 * orchestrator (which feeds it to the communicator so it cannot invent changes)
 * and by the conversation context file (so a later turn knows what really
 * happened, even after the model's own history has been trimmed or reloaded).
 */
export function describeAction(call: ToolCall, result: ToolResult): string {
  let prefix = "read";
  if (WRITE_TOOLS.has(call.name)) prefix = result.isError ? "attempted-change" : "changed";
  else if (COMMAND_TOOLS.has(call.name)) prefix = "ran";
  const status = result.isError ? `ERROR: ${oneLine(result.content)}` : "ok";
  return `${prefix}: ${call.name} ${summarizeCall(call)} → ${status}`;
}

/** A short human-readable summary of what a tool call targeted. */
export function summarizeCall(c: ToolCall): string {
  const i = (c.input || {}) as Record<string, unknown>;
  if (i.command) return String(i.command);
  if (i.args) return `git ${i.args}`;
  if (i.path) return String(i.path);
  if (i.pattern) return `/${i.pattern}/`;
  return "";
}

export function oneLine(s: string): string {
  return (s || "").replace(/\s+/g, " ").slice(0, 200);
}
