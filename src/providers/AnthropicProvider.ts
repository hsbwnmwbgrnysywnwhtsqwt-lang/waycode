import {
  AIProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ProviderCredentials,
  ToolCall,
} from "./types";

/**
 * Anthropic Messages API provider.
 * Docs: https://docs.anthropic.com/en/api/messages
 */
export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly label = "Anthropic (Claude)";
  readonly requiresApiKey = true;

  constructor(private readonly creds: ProviderCredentials) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.creds.apiKey) {
      throw new Error("Anthropic API key is not set. Run 'WayCode: Set API Key'.");
    }

    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0,
      system: req.system,
      messages: this.toAnthropicMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.creds.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }

    const data: any = await res.json();
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
      }
    }

    return {
      text,
      toolCalls,
      stopReason: this.mapStop(data.stop_reason),
      usage: {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
      },
    };
  }

  private mapStop(reason: string): CompletionResponse["stopReason"] {
    switch (reason) {
      case "tool_use":
        return "tool_use";
      case "end_turn":
      case "stop_sequence":
        return "end";
      case "max_tokens":
        return "max_tokens";
      default:
        return "other";
    }
  }

  /** Convert neutral messages to Anthropic's content-block format. */
  private toAnthropicMessages(messages: ChatMessage[]): any[] {
    const out: any[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        out.push({ role: "user", content: m.content ?? "" });
      } else if (m.role === "assistant") {
        const content: any[] = [];
        if (m.content) {
          content.push({ type: "text", text: m.content });
        }
        for (const c of m.toolCalls ?? []) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        }
        out.push({ role: "assistant", content });
      } else if (m.role === "tool") {
        const content = (m.toolResults ?? []).map((r) => ({
          type: "tool_result",
          tool_use_id: r.callId,
          content: r.content,
          is_error: r.isError ?? false,
        }));
        out.push({ role: "user", content });
      }
    }
    return out;
  }
}
