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
 * Google Gemini provider (generateContent).
 * Docs: https://ai.google.dev/api/generate-content
 */
export class GeminiProvider implements AIProvider {
  readonly id = "gemini";
  readonly label = "Google (Gemini)";
  readonly requiresApiKey = true;

  constructor(private readonly creds: ProviderCredentials) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.creds.apiKey) {
      throw new Error("Gemini API key is not set. Run 'WayCode: Set API Key'.");
    }
    const base = this.creds.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const url = `${base}/models/${req.model}:generateContent?key=${this.creds.apiKey}`;

    const body: any = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: this.toGeminiContents(req.messages),
      generationConfig: {
        temperature: req.temperature ?? 0,
        maxOutputTokens: req.maxTokens ?? 4096,
      },
    };
    if (req.tools.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const res = await postJson(url, {}, body);

    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${await readError(res)}`);
    }

    const data: any = await res.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    let idx = 0;
    for (const p of parts) {
      if (p.text) {
        text += p.text;
      } else if (p.functionCall) {
        toolCalls.push({
          id: `gemini-${Date.now()}-${idx++}`,
          name: p.functionCall.name,
          input: p.functionCall.args ?? {},
        });
      }
    }

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "end",
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  private toGeminiContents(messages: ChatMessage[]): any[] {
    const out: any[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        out.push({ role: "user", parts: [{ text: m.content ?? "" }] });
      } else if (m.role === "assistant") {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const c of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: c.name, args: c.input } });
        }
        out.push({ role: "model", parts });
      } else if (m.role === "tool") {
        const parts = (m.toolResults ?? []).map((r) => ({
          functionResponse: {
            name: r.callId,
            response: { result: r.content },
          },
        }));
        out.push({ role: "user", parts });
      }
    }
    return out;
  }
}
