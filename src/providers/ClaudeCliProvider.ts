import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  AIProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ProviderCredentials,
} from "./types";

/**
 * Uses the locally-installed **Claude Code CLI** (`claude`) as a text backend —
 * no API key required; it authenticates with the user's existing Claude Code
 * subscription (OAuth/keychain). Runs in print mode (`claude -p`).
 *
 * This is a TEXT provider: it does not expose WayCode-style tool calling, so it
 * shines as the COMMUNICATOR (language/routing/explanation) role — pair it with
 * a tool-capable coder (e.g. a local Ollama model).
 */
export class ClaudeCliProvider implements AIProvider {
  readonly id = "claude-cli";
  readonly label = "Claude Code (CLI, no key)";
  readonly requiresApiKey = false;

  constructor(private readonly creds: ProviderCredentials) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const prompt = this.renderConversation(req.messages);
    const raw = await this.runClaude(req.system, prompt, req.model);
    return { text: raw.text, toolCalls: [], stopReason: "end", usage: raw.usage };
  }

  private renderConversation(messages: ChatMessage[]): string {
    return messages
      .map((m) => {
        if (m.role === "user") return m.content ?? "";
        if (m.role === "assistant") return `Assistant: ${m.content ?? ""}`;
        if (m.role === "tool") {
          return `Tool results:\n${(m.toolResults ?? []).map((r) => r.content).join("\n")}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private async runClaude(
    system: string,
    prompt: string,
    model: string
  ): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
    // The system prompt can be large (project tree); pass it via a temp file.
    const sysFile = path.join(
      os.tmpdir(),
      `waycode-sys-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );
    await fs.writeFile(sysFile, system, "utf8");

    const args = ["-p", "--output-format", "json", "--system-prompt-file", sysFile];
    if (model && model !== "default") {
      args.push("--model", model);
    }
    if (this.creds.baseUrl) {
      // Optional: run the CLI with the workspace as an allowed dir for context.
      args.push("--add-dir", this.creds.baseUrl);
    }

    try {
      return await new Promise((resolve, reject) => {
        const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);

        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (err += d.toString()));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(
            new Error(
              `Could not run the 'claude' CLI: ${e.message}. Install Claude Code and run 'claude' once to sign in.`
            )
          );
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0 && !out.trim()) {
            reject(new Error(`Claude CLI exited with code ${code}: ${err.trim() || "(no output)"}`));
            return;
          }
          resolve(this.parseResult(out));
        });

        child.stdin.write(prompt);
        child.stdin.end();
      });
    } finally {
      fs.unlink(sysFile).catch(() => {
        /* best effort */
      });
    }
  }

  private parseResult(stdout: string): {
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  } {
    try {
      const data = JSON.parse(stdout);
      const text = String(data.result ?? "");
      if (data.is_error) {
        throw new Error(`Claude CLI: ${text || "unknown error"}`);
      }
      return {
        text,
        usage: {
          inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens,
        },
      };
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Claude CLI:")) throw e;
      // Not JSON — return the raw text.
      return { text: stdout.trim() };
    }
  }
}
