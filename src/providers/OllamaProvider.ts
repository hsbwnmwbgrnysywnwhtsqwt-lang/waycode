import {
  AIProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ProviderCredentials,
  ToolCall,
} from "./types";

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

    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }

    const data: any = await res.json();
    const msg = data.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
      id: `ollama-${Date.now()}-${i}`,
      name: tc.function?.name,
      input: tc.function?.arguments ?? {},
    }));

    return {
      text: msg.content ?? "",
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "end",
      usage: {
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
      },
    };
  }

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
