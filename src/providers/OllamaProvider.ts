import {
  AIProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ProviderCredentials,
  ToolCall,
} from "./types";
import { postJson, readError } from "./http";

/**
 * Local models via Ollama's chat API.
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 * No API key required.
 */
export class OllamaProvider implements AIProvider {
  readonly id = "ollama";
  readonly label = "Ollama (local)";
  readonly requiresApiKey = false;

  constructor(private readonly creds: ProviderCredentials) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const base = this.creds.baseUrl ?? "http://localhost:11434";

    const body: any = {
      model: req.model,
      stream: false,
      options: { temperature: req.temperature ?? 0 },
      messages: this.toOllamaMessages(req.system, req.messages),
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const res = await postJson(`${base}/api/chat`, {}, body);

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await readError(res)}`);
    }

    const data: any = await res.json();
    const msg = data.message ?? {};
    let text: string = msg.content ?? "";
    let toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
      id: `ollama-${Date.now()}-${i}`,
      name: tc.function?.name,
      input: normalizeArgs(tc.function?.arguments),
    }));

    // Fallback: many local models (incl. qwen2.5-coder) emit tool calls as JSON
    // text in `content` instead of the structured `tool_calls` field. Recover them.
    if (!toolCalls.length && text.trim()) {
      const offered = new Set(req.tools.map((t) => t.name));
      const extracted = extractToolCallsFromText(text, offered);
      if (extracted.calls.length) {
        toolCalls = extracted.calls;
        text = extracted.remainder;
      }
    }

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "end",
      usage: {
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
      },
    };
  }

  // (message conversion below)
  private toOllamaMessages(system: string, messages: ChatMessage[]): any[] {
    const out: any[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") {
        out.push({ role: "user", content: m.content ?? "" });
      } else if (m.role === "assistant") {
        const entry: any = { role: "assistant", content: m.content ?? "" };
        if (m.toolCalls?.length) {
          entry.tool_calls = m.toolCalls.map((c) => ({
            function: { name: c.name, arguments: c.input },
          }));
        }
        out.push(entry);
      } else if (m.role === "tool") {
        for (const r of m.toolResults ?? []) {
          out.push({ role: "tool", content: r.content });
        }
      }
    }
    return out;
  }
}

/** Ollama's native tool_calls sometimes carry arguments as a JSON string. */
function normalizeArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  if (typeof args === "string") {
    const parsed = tryParseJson(args);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  }
  return {};
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

function looksLikeCall(o: any): boolean {
  return o && typeof o === "object" && typeof o.name === "string" && ("arguments" in o || "parameters" in o);
}

function makeCall(o: any, i: number): ToolCall {
  const rawArgs = o.arguments ?? o.parameters ?? {};
  return { id: `ollama-${Date.now()}-${i}`, name: o.name, input: normalizeArgs(rawArgs) };
}

/**
 * Recover tool calls that a local model emitted as text instead of using the
 * structured field. Handles: <tool_call>{…}</tool_call> tags (qwen native),
 * ```json fenced blocks, and a bare JSON object/array that is the whole content.
 *
 * The recovered calls are EXECUTED, so the looser the shape, the stricter the
 * rules. Small local models routinely answer with a numbered PLAN carrying one
 * speculative JSON call per step; running the whole list fires edits and
 * commands the model never got to reconsider after seeing the first result
 * (this is how a "step 10" write_file once overwrote a README). So:
 *
 * - <tool_call> tags are the model's native declaration format — a batch of
 *   them is deliberate and is honoured as written.
 * - Fenced blocks and bare JSON in prose are ambiguous: take the FIRST call
 *   only, and feed its result back so the model continues one step at a time.
 * - Bare JSON in prose, the loosest shape of all, must also name a tool that
 *   was actually offered. A call-shaped object in prose (a code sample, a
 *   config snippet) is text, not an action.
 */
function extractToolCallsFromText(
  text: string,
  offered: ReadonlySet<string>
): { calls: ToolCall[]; remainder: string } {
  const calls: ToolCall[] = [];
  let i = 0;

  // 1) <tool_call>…</tool_call> blocks — an explicit declaration; a batch is real.
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const obj = tryParseJson(m[1]);
    if (looksLikeCall(obj)) calls.push(makeCall(obj, i++));
  }
  if (calls.length) return { calls, remainder: text.replace(tagRe, "").trim() };

  // 2) ```json fenced blocks — ambiguous, so the first call only.
  const fenceRe = /```(?:json|tool_call)?\s*([\s\S]*?)```/g;
  while ((m = fenceRe.exec(text)) !== null) {
    const obj = tryParseJson(m[1]);
    if (looksLikeCall(obj)) calls.push(makeCall(obj, i++));
    else if (Array.isArray(obj)) for (const o of obj) if (looksLikeCall(o)) calls.push(makeCall(o, i++));
    if (calls.length) break;
  }
  if (calls.length) return { calls: calls.slice(0, 1), remainder: text.replace(fenceRe, "").trim() };

  // 3) Balanced JSON object(s) anywhere in the text — handles models that wrap
  //    the tool call in explanatory prose (e.g. "…let's proceed. {…}"). Loosest
  //    shape: the name must be a real, offered tool, and the first call only.
  const accept = (o: unknown): boolean => looksLikeCall(o) && offered.has(String((o as any).name));
  for (const raw of findBalancedJsonObjects(text)) {
    const obj = tryParseJson(raw);
    if (accept(obj)) calls.push(makeCall(obj, i++));
    else if (Array.isArray(obj)) for (const o of obj) if (accept(o)) calls.push(makeCall(o, i++));
    if (calls.length) {
      return { calls: calls.slice(0, 1), remainder: text.split(raw).join("").trim() };
    }
  }

  return { calls, remainder: text };
}

/**
 * Scan text for top-level balanced `{ … }` substrings, respecting string
 * literals and escapes, so we can find a JSON object embedded in prose.
 */
function findBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          objects.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return objects;
}
