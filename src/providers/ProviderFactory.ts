import { AIProvider, ProviderCredentials } from "./types";
import { AnthropicProvider } from "./AnthropicProvider";
import { OpenAIProvider } from "./OpenAIProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OllamaProvider } from "./OllamaProvider";

export type ProviderId = "anthropic" | "openai" | "gemini" | "ollama";

export const PROVIDER_META: Record<ProviderId, { label: string; requiresApiKey: boolean; defaultModel: string }> = {
  anthropic: { label: "Anthropic (Claude)", requiresApiKey: true, defaultModel: "claude-sonnet-4-5" },
  openai: { label: "OpenAI (GPT)", requiresApiKey: true, defaultModel: "gpt-4o" },
  gemini: { label: "Google (Gemini)", requiresApiKey: true, defaultModel: "gemini-2.0-flash" },
  ollama: { label: "Ollama (local)", requiresApiKey: false, defaultModel: "llama3.1" },
};

/**
 * Single place that knows how to construct a provider. Swapping models/providers
 * anywhere in the app is just a call to this factory — the rest of the code only
 * ever sees the {@link AIProvider} interface.
 */
export function createProvider(id: ProviderId, creds: ProviderCredentials): AIProvider {
  switch (id) {
    case "anthropic":
      return new AnthropicProvider(creds);
    case "openai":
      return new OpenAIProvider(creds);
    case "gemini":
      return new GeminiProvider(creds);
    case "ollama":
      return new OllamaProvider(creds);
    default:
      throw new Error(`Unknown provider: ${id}`);
  }
}
