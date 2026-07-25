import { Tool, ToolContext, ToolRunResult } from "./Tool";
import { runCommand } from "./exec";

/**
 * Build the shell search command. Prefers ripgrep; falls back to `grep -E`.
 * The `-E` is essential: VS Code's extension host often has no `rg` on PATH, and
 * plain `grep` (BRE) treats `(a|b)` alternation as a literal string — silently
 * finding nothing. `-E` (ERE) makes the fallback handle regex like ripgrep does.
 */
export function buildSearchCommand(pattern: string, glob: string | undefined, caseSensitive: boolean): string {
  const caseFlag = caseSensitive ? "" : "-i ";
  const escaped = pattern.replace(/'/g, "'\\''");
  const globArg = glob ? `-g '${glob.replace(/'/g, "'\\''")}'` : "";
  const rg = `rg -n --no-heading --color never ${caseFlag}${globArg} -- '${escaped}' .`;
  const grep = `grep -rnE ${caseFlag}--exclude-dir=node_modules --exclude-dir=.git -- '${escaped}' .`;
  return `${rg} || ${grep}`;
}

/** Search file contents across the workspace. */
export class GrepTool implements Tool {
  readonly name = "search_code";
  readonly description =
    "Search the workspace for a text pattern (regex) and return matching files and lines. Case-insensitive by default. Use to locate relevant code.";
  readonly risk = "read" as const;
  readonly parameters = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex or literal text to search for." },
      glob: { type: "string", description: "Optional file glob to limit the search, e.g. '*.ts'." },
      case_sensitive: {
        type: "boolean",
        description: "Match case exactly. Defaults to false (case-insensitive) so 'gemini' also finds 'Gemini'.",
      },
    },
    required: ["pattern"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const pattern = String(input.pattern ?? "");
    const glob = input.glob ? String(input.glob) : undefined;
    const command = buildSearchCommand(pattern, glob, Boolean(input.case_sensitive));
    ctx.log(`🔍 search "${pattern}"`);
    const res = await runCommand(command, ctx.workspaceRoot, 60_000);
    const out = res.stdout.trim() || "(no matches)";
    return { output: capMatches(out) };
  }
}

/** Keep a broad search from swamping a small local model's context window. */
const MAX_MATCH_LINES = 120;

/**
 * Trim a long match list, keeping enough to see WHICH files are involved. A
 * broad pattern can match thousands of lines; a 7B model handed all of them
 * loses the thread entirely, so we cut it and say so explicitly (the model needs
 * to know the list is partial, otherwise it will "conclude" from a slice).
 */
export function capMatches(out: string, maxLines = MAX_MATCH_LINES): string {
  const lines = out.split("\n");
  if (lines.length <= maxLines) return out;
  const files = new Set(lines.map((l) => l.split(":")[0]).filter(Boolean));
  return [
    lines.slice(0, maxLines).join("\n"),
    `… ${lines.length - maxLines} more matching lines across ${files.size} files were cut.`,
    `This list is PARTIAL — narrow the pattern or pass a glob before drawing any conclusion.`,
  ].join("\n");
}

/**
 * Error Analyzer — parses compiler/test/runtime output and extracts the most
 * actionable signals (file:line, error codes, likely cause) so the agent can
 * fix problems methodically instead of guessing.
 */
export class ErrorAnalyzerTool implements Tool {
  readonly name = "analyze_error";
  readonly description =
    "Analyze error output (compiler, test, or runtime) and extract file locations, error codes, and a structured summary to guide a fix.";
  readonly risk = "read" as const;
  readonly parameters = {
    type: "object",
    properties: {
      output: { type: "string", description: "The raw error/log output to analyze." },
    },
    required: ["output"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const text = String(input.output ?? "");
    ctx.log(`🩺 analyzing error output`);

    const locations = new Set<string>();
    const codes = new Set<string>();
    // file:line[:col] patterns
    const locRe = /([\w./\-]+\.\w+):(\d+)(?::(\d+))?/g;
    let m: RegExpExecArray | null;
    while ((m = locRe.exec(text)) !== null) {
      locations.add(`${m[1]}:${m[2]}${m[3] ? ":" + m[3] : ""}`);
    }
    // error codes like TS1234, error[E0499], SyntaxError
    const codeRe = /\b(TS\d+|E\d{2,4}|[A-Z][a-zA-Z]+Error|error\[[^\]]+\])\b/g;
    while ((m = codeRe.exec(text)) !== null) {
      codes.add(m[1]);
    }

    const summary = [
      `Locations found: ${locations.size ? [...locations].slice(0, 20).join(", ") : "none"}`,
      `Error signatures: ${codes.size ? [...codes].slice(0, 20).join(", ") : "none"}`,
      `Suggested next step: read the first location above, then apply a targeted edit_file and re-run the failing command.`,
    ].join("\n");

    return { output: summary };
  }
}
