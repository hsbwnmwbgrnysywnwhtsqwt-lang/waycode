/**
 * Provider-agnostic types shared by every AI backend.
 * Each concrete provider (Anthropic, OpenAI, Ollama) maps these
 * neutral shapes to and from its own wire format.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** A single tool the model is allowed to call. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  parameters: Record<string, unknown>;
}

/** A tool call requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result of running a tool, fed back to the model. */
export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: Role;
  /** Free text content. */
  content?: string;
  /** Present on assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool-role turns that carry results. */
  toolResults?: ToolResult[];
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResponse {
  /** Assistant free-text (may be empty when only tools were called). */
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Every AI backend implements this single interface. */
export interface AIProvider {
  readonly id: string;
  readonly label: string;
  /** Whether this provider needs an API key (Ollama does not). */
  readonly requiresApiKey: boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
}
