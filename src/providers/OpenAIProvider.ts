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
 * OpenAI Chat Completions provider (also compatible with Azure/OpenAI-style
 * endpoints via a custom baseUrl).
 * Docs: https://platform.openai.com/docs/api-reference/chat
 */
export class OpenAIProvider implements AIProvider {
  readonly id = "openai";
  readonly label = "OpenAI (GPT)";
  readonly requiresApiKey = true;

  constructor(private readonly creds: ProviderCredentials) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.creds.apiKey) {
      throw new Error("OpenAI API key is not set. Run 'WayCode: Set API Key'.");
    }
    const baseUrl = this.creds.baseUrl ?? "https://api.openai.com/v1";

    const body = {
      model: req.model,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 4096,
      messages: this.toOpenAIMessages(req.system, req.messages),
      tools: req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: req.tools.length ? "auto" : undefined,
    };

    const res = await postJson(
      `${baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.creds.apiKey}` },
      body
    );

    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${await readError(res)}`);
    }

    const data: any = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      input: safeParse(tc.function?.arguments),
    }));

    return {
      text: msg.content ?? "",
      toolCalls,
      stopReason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end",
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      },
    };
  }

  private toOpenAIMessages(system: string, messages: ChatMessage[]): any[] {
    const out: any[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") {
        out.push({ role: "user", content: m.content ?? "" });
      } else if (m.role === "assistant") {
        const entry: any = { role: "assistant", content: m.content ?? "" };
        if (m.toolCalls?.length) {
          entry.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          }));
        }
        out.push(entry);
      } else if (m.role === "tool") {
        for (const r of m.toolResults ?? []) {
          out.push({ role: "tool", tool_call_id: r.callId, content: r.content });
        }
      }
    }
    return out;
  }
}

function safeParse(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
