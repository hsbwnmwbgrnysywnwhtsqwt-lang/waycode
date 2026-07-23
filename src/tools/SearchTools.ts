import { Tool, ToolContext, ToolRunResult } from "./Tool";
import { runCommand } from "./exec";

/** Search file contents across the workspace. */
export class GrepTool implements Tool {
  readonly name = "search_code";
  readonly description =
    "Search the workspace for a text pattern (regex) and return matching files and lines. Use to locate relevant code.";
  readonly risk = "read" as const;
  readonly parameters = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex or literal text to search for." },
      glob: { type: "string", description: "Optional file glob to limit the search, e.g. '*.ts'." },
    },
    required: ["pattern"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const pattern = String(input.pattern ?? "");
    const glob = input.glob ? String(input.glob) : undefined;
    const escaped = pattern.replace(/'/g, "'\\''");
    // Prefer ripgrep if available, otherwise fall back to grep.
    const globArg = glob ? `-g '${glob.replace(/'/g, "'\\''")}'` : "";
    const rg = `rg -n --no-heading --color never ${globArg} -- '${escaped}' . || grep -rn --exclude-dir=node_modules --exclude-dir=.git -- '${escaped}' .`;
    ctx.log(`🔍 search "${pattern}"`);
    const res = await runCommand(rg, ctx.workspaceRoot, 60_000);
    const out = res.stdout.trim() || "(no matches)";
    return { output: out };
  }
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
