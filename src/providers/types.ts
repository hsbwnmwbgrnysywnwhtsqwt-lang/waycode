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

/** An image attached to a user turn, for providers that can see pictures. */
export interface ImageAttachment {
  /** e.g. "image/png" */
  mediaType: string;
  /** Raw base64, no data: prefix. */
  base64: string;
  /** Workspace-relative path, so the model can also act on the file. */
  path?: string;
}

export interface ChatMessage {
  role: Role;
  /** Free text content. */
  content?: string;
  /** Images attached to a user turn. Ignored by providers without vision. */
  images?: ImageAttachment[];
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
  /**
   * Problems with the request itself that the user needs to know about — most
   * importantly a prompt too large for the context window, which the backend
   * would otherwise truncate in silence.
   */
  warnings?: string[];
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
  /**
   * Ollama only: pin num_ctx instead of sizing it from the request. Useful when
   * a machine cannot spare the memory a large window reserves.
   */
  contextTokens?: number;
}
