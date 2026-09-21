import {
  AIProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ProviderCredentials,
  ToolCall,
} from "./types";
import { postJsonLines } from "./http";
import { chooseContextWindow, fetchModelGeometry, stickyWindow } from "./ollamaContext";

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

    const messages = this.toOllamaMessages(req.system, req.messages);

    // num_ctx MUST be set. Ollama's default context is ~4k tokens, and it
    // silently truncates anything longer — so an agent prompt (system rules +
    // project tree + an attached file + 15 tool schemas + history) arrives with
    // most of itself missing, frequently including the tool definitions. That is
    // invisible from the outside and looks exactly like a model that "ignores
    // its tools", "cannot find a file that is right there", or repeats itself.
    //
    // It must not be set to the largest window that fits the prompt either: past
    // what the machine can hold, the KV cache pushes the model off the GPU and
    // inference collapses to a few seconds per token. See ollamaContext.ts.
    const geometry = await fetchModelGeometry(base, req.model);
    const choice = chooseContextWindow({
      needed: this.neededTokens(messages, req.tools.length),
      geometry,
      pinned: Number(this.creds.contextTokens) || undefined,
    });
    const numCtx = stickyWindow(`${base}::${req.model}`, choice.tokens);

    const options: Record<string, unknown> = {
      temperature: req.temperature ?? 0,
      num_ctx: numCtx,
    };

    const body: any = {
      // Streaming is not about showing tokens as they land — it is what makes
      // the request survivable. A non-streamed call has to finish inside one
      // wall-clock deadline; a streamed one only has to keep making progress.
      model: req.model,
      stream: true,
      options,
      messages,
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

    const data = await this.readStream(`${base}/api/chat`, body);

    let text: string = data.content;
    let toolCalls: ToolCall[] = data.toolCalls.map((tc: any, i: number) => ({
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
        inputTokens: data.promptEvalCount,
        outputTokens: data.evalCount,
      },
      warnings: choice.warning ? [choice.warning] : undefined,
    };
  }

  /**
   * Consume Ollama's NDJSON stream into one assembled reply.
   *
   * Content arrives a fragment at a time; tool calls arrive whole, on whichever
   * chunk the model finished them. The final object (`done: true`) carries the
   * token counts and nothing else worth keeping.
   */
  private async readStream(
    url: string,
    body: unknown
  ): Promise<{ content: string; toolCalls: any[]; promptEvalCount?: number; evalCount?: number }> {
    let content = "";
    const toolCalls: any[] = [];
    let promptEvalCount: number | undefined;
    let evalCount: number | undefined;

    await postJsonLines(url, {}, body, (value) => {
      const chunk = value as any;
      if (chunk?.error) throw new Error(`Ollama error: ${chunk.error}`);
      const msg = chunk?.message;
      if (msg?.content) content += msg.content;
      if (Array.isArray(msg?.tool_calls)) toolCalls.push(...msg.tool_calls);
      if (chunk?.done) {
        promptEvalCount = chunk.prompt_eval_count;
        evalCount = chunk.eval_count;
      }
    });

    return { content, toolCalls, promptEvalCount, evalCount };
  }

  // (message conversion below)
  /**
   * Estimate the tokens this request needs, reply included.
   *
   * Only an estimate is possible without running the tokenizer, and it only has
   * to be good enough to pick between a handful of window sizes.
   */
  private neededTokens(messages: Array<{ content?: string }>, toolCount: number): number {
    const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    // ~3.5 chars/token is a safe estimate across English, Hebrew and code, plus
    // roughly 220 tokens per tool schema, plus room for the reply.
    return Math.ceil(chars / 3.5) + toolCount * 220 + 1500;
  }

  private toOllamaMessages(system: string, messages: ChatMessage[]): any[] {
    const out: any[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") {
        // Ollama vision models take a plain array of base64 images.
        out.push(
          m.images?.length
            ? { role: "user", content: m.content ?? "", images: m.images.map((i) => i.base64) }
            : { role: "user", content: m.content ?? "" }
        );
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
