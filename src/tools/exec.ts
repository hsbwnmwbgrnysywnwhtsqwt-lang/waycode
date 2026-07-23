import { exec } from "child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 30_000;

/** Run a shell command in the workspace with a timeout and output cap. */
export function runCommand(command: string, cwd: string, timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = exec(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && (err as any).killed && (err as any).signal === "SIGTERM");
      resolve({
        code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        timedOut,
      });
    });
    child.on("error", () => {
      /* handled by exec callback */
    });
  });
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n… [truncated ${s.length - MAX_OUTPUT} chars]`;
}
