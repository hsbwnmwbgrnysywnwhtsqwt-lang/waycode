import { Tool, ToolContext, ToolRunResult } from "./Tool";
import { runCommand } from "./exec";

/** Run an arbitrary shell command (always requires approval). */
export class TerminalTool implements Tool {
  readonly name = "run_terminal";
  readonly description =
    "Run a shell command in the workspace root and return its stdout/stderr and exit code. Use for builds, package installs, scripts, etc.";
  readonly risk = "execute" as const;
  readonly parameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      reason: { type: "string", description: "Short explanation of why this command is needed." },
    },
    required: ["command"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const command = String(input.command ?? "");
    const reason = input.reason ? String(input.reason) : undefined;
    const approved = await ctx.requestApproval({
      title: "Run command",
      detail: reason ? `${command}\n\n# ${reason}` : command,
    });
    if (!approved) {
      return { output: "User rejected running the command.", isError: true };
    }
    ctx.log(`💻 $ ${command}`);
    const res = await runCommand(command, ctx.workspaceRoot);
    return {
      output: formatResult(res),
      isError: res.code !== 0,
    };
  }
}

/** Git operations restricted to a safe subset (status/diff/log/add/commit). */
export class GitTool implements Tool {
  readonly name = "git";
  readonly description =
    "Run a git subcommand. Read commands (status, diff, log, branch) run automatically; write commands (add, commit, checkout, restore) ask for approval.";
  readonly risk = "execute" as const;
  readonly parameters = {
    type: "object",
    properties: {
      args: { type: "string", description: "Arguments after 'git', e.g. 'status', 'diff HEAD', 'add -A'." },
    },
    required: ["args"],
  };

  private static readonly READONLY = new Set(["status", "diff", "log", "branch", "show", "blame", "remote"]);

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const args = String(input.args ?? "").trim();
    const sub = args.split(/\s+/)[0] ?? "";
    const command = `git ${args}`;

    if (!GitTool.READONLY.has(sub)) {
      const approved = await ctx.requestApproval({ title: "Git command", detail: command });
      if (!approved) {
        return { output: "User rejected the git command.", isError: true };
      }
    }
    ctx.log(`🔀 $ ${command}`);
    const res = await runCommand(command, ctx.workspaceRoot);
    return { output: formatResult(res), isError: res.code !== 0 };
  }
}

/** Run the project's test suite. */
export class TestTool implements Tool {
  readonly name = "run_tests";
  readonly description =
    "Run the project's tests. Provide the test command (e.g. 'npm test', 'pytest', 'go test ./...'). Defaults to 'npm test'.";
  readonly risk = "execute" as const;
  readonly parameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "Test command to run. Defaults to 'npm test'." },
    },
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const command = String(input.command ?? "npm test");
    const approved = await ctx.requestApproval({ title: "Run tests", detail: command });
    if (!approved) {
      return { output: "User rejected running tests.", isError: true };
    }
    ctx.log(`🧪 $ ${command}`);
    const res = await runCommand(command, ctx.workspaceRoot, 300_000);
    return { output: formatResult(res), isError: res.code !== 0 };
  }
}

/** Run a linter and return findings. */
export class LintTool implements Tool {
  readonly name = "run_linter";
  readonly description =
    "Run a linter/formatter check (e.g. 'npm run lint', 'eslint .', 'ruff check'). Returns the findings.";
  readonly risk = "execute" as const;
  readonly parameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "Lint command to run." },
    },
    required: ["command"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const command = String(input.command ?? "");
    const approved = await ctx.requestApproval({ title: "Run linter", detail: command });
    if (!approved) {
      return { output: "User rejected running the linter.", isError: true };
    }
    ctx.log(`🔎 $ ${command}`);
    const res = await runCommand(command, ctx.workspaceRoot, 180_000);
    return { output: formatResult(res), isError: res.code !== 0 };
  }
}

function formatResult(res: { code: number; stdout: string; stderr: string; timedOut: boolean }): string {
  const parts = [`exit code: ${res.code}${res.timedOut ? " (timed out)" : ""}`];
  if (res.stdout.trim()) parts.push(`--- stdout ---\n${res.stdout.trim()}`);
  if (res.stderr.trim()) parts.push(`--- stderr ---\n${res.stderr.trim()}`);
  return parts.join("\n\n");
}
