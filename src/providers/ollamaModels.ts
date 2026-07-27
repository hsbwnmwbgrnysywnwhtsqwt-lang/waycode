import * as os from "os";

/** How well a model can fill the CODER role (the one that drives the tools). */
export type CoderFit = "good" | "marginal" | "weak" | "unusable";

/** One model installed on this machine, with everything we can tell about it. */
export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  /** As reported by Ollama, e.g. "14.8B". */
  parameterSize?: string;
  /** The same value as a number of billions, for comparisons. */
  parameterBillions?: number;
  quantization?: string;
  contextLength?: number;
  family?: string;
  /** Ollama's own capability list — the authority on whether tools work at all. */
  capabilities: string[];
  supportsTools: boolean;
  coderFit: CoderFit;
  /** Short human-readable verdict, shown next to the model in the pickers. */
  note: string;
  /** True when loading this model is likely to exhaust this machine's memory. */
  heavyForThisMachine: boolean;
}

/**
 * A model must clear this to drive WayCode's tools with any reliability.
 *
 * Measured, not guessed: qwen2.5-coder:7b produces the right tool JSON for a toy
 * request, but on a real 500-line file it emits an empty `old_text` and truncates
 * the JSON mid-string — so the edit never happens and the run silently does
 * nothing. Below ~13B that failure is the norm, not the exception.
 */
const MIN_CODER_BILLIONS = 13;
/** Above this, agentic editing is genuinely dependable. */
const GOOD_CODER_BILLIONS = 30;
/** A coder needs room for a big file plus the conversation. */
const MIN_CODER_CONTEXT = 16_384;

/** Fraction of total RAM a model may occupy before we warn about swapping. */
const RAM_BUDGET = 0.6;

/** A local `ollama list` is instant; anything slower means it is not there. */
const SCAN_TIMEOUT_MS = 5_000;

interface TagsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    capabilities?: string[];
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
      context_length?: number;
    };
  }>;
}

/**
 * Scan the local machine for installed Ollama models and describe each one.
 * Returns an empty list when Ollama is not running — callers fall back to free
 * text entry.
 */
export async function fetchOllamaModels(
  baseUrl: string,
  totalMemoryBytes = os.totalmem()
): Promise<OllamaModelInfo[]> {
  let data: TagsResponse;
  try {
    // A wrong or unreachable baseUrl must not hang the model picker with no way
    // out — an unreachable host can leave a bare fetch pending indefinitely.
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(SCAN_TIMEOUT_MS) });
    if (!res.ok) return [];
    data = (await res.json()) as TagsResponse;
  } catch {
    return [];
  }
  return (data.models ?? [])
    .filter((m) => m.name)
    .map((m) => describeModel(m, totalMemoryBytes))
    .sort((a, b) => FIT_ORDER[a.coderFit] - FIT_ORDER[b.coderFit] || a.name.localeCompare(b.name));
}

/** Best-fit models first, so the picker's top entry is the one to choose. */
const FIT_ORDER: Record<CoderFit, number> = { good: 0, marginal: 1, weak: 2, unusable: 3 };

export function describeModel(
  m: NonNullable<TagsResponse["models"]>[number],
  totalMemoryBytes: number
): OllamaModelInfo {
  const capabilities = m.capabilities ?? [];
  const supportsTools = capabilities.includes("tools");
  const parameterSize = m.details?.parameter_size;
  const parameterBillions = parseBillions(parameterSize);
  const contextLength = m.details?.context_length;
  const sizeBytes = m.size ?? 0;
  const heavyForThisMachine = sizeBytes > totalMemoryBytes * RAM_BUDGET;

  const { coderFit, note } = judge({
    supportsTools,
    parameterSize,
    parameterBillions,
    contextLength,
    heavyForThisMachine,
  });

  return {
    name: m.name as string,
    sizeBytes,
    parameterSize,
    parameterBillions,
    quantization: m.details?.quantization_level,
    contextLength,
    family: m.details?.family,
    capabilities,
    supportsTools,
    coderFit,
    note,
    heavyForThisMachine,
  };
}

function judge(x: {
  supportsTools: boolean;
  parameterSize?: string;
  parameterBillions?: number;
  contextLength?: number;
  heavyForThisMachine: boolean;
}): { coderFit: CoderFit; note: string } {
  // No tool support is disqualifying on its own: the coder role IS tool calling.
  if (!x.supportsTools) {
    return { coderFit: "unusable", note: "no tool support — communicator only" };
  }
  if (x.parameterBillions !== undefined && x.parameterBillions < MIN_CODER_BILLIONS) {
    return {
      coderFit: "weak",
      note: `${x.parameterSize ?? "small"} — too small to edit files reliably`,
    };
  }
  if (x.contextLength !== undefined && x.contextLength < MIN_CODER_CONTEXT) {
    return { coderFit: "weak", note: `${x.contextLength} ctx — too small for real files` };
  }
  if (x.heavyForThisMachine) {
    return { coderFit: "marginal", note: "may exceed this machine's RAM" };
  }
  if (x.parameterBillions !== undefined && x.parameterBillions < GOOD_CODER_BILLIONS) {
    return { coderFit: "marginal", note: "usable as coder — expect occasional misses" };
  }
  return { coderFit: "good", note: "good fit for the coder role" };
}

/** "14.8B" → 14.8; "500M" → 0.5. */
export function parseBillions(size?: string): number | undefined {
  if (!size) return undefined;
  const m = /^([\d.]+)\s*([BM])/i.exec(size.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2].toUpperCase() === "M" ? n / 1000 : n;
}

/** e.g. "9.0 GB · 14.8B · Q4_K_M · 32k ctx". */
export function formatSpecs(m: OllamaModelInfo): string {
  const parts: string[] = [];
  if (m.sizeBytes) parts.push(`${(m.sizeBytes / 1e9).toFixed(1)} GB`);
  if (m.parameterSize) parts.push(m.parameterSize);
  if (m.quantization) parts.push(m.quantization);
  if (m.contextLength) parts.push(`${Math.round(m.contextLength / 1024)}k ctx`);
  return parts.join(" · ");
}

/** The icon shown beside a model, so the verdict is readable at a glance. */
export function fitIcon(fit: CoderFit): string {
  return { good: "✅", marginal: "🟡", weak: "⚠️", unusable: "⛔" }[fit];
}

/** A local model we can actually recommend for the coder role. */
export interface CoderRecommendation {
  name: string;
  /** Roughly what `ollama pull` will put on disk. */
  downloadGB: number;
  /** RAM the machine needs for this to run without swapping. */
  needsRamGB: number;
  why: string;
}

/**
 * The two local models worth running as the coder, in preference order.
 *
 * Both are built for agentic tool use rather than autocomplete, which is the
 * distinction that matters here: the dense mid-size coder models (7B–14B) parse
 * a file happily and then fail to emit a valid tool call, so they read your
 * code and change nothing.
 */
export const RECOMMENDED_CODERS: CoderRecommendation[] = [
  {
    name: "qwen3-coder:30b",
    downloadGB: 19,
    needsRamGB: 32,
    why: "mixture-of-experts: 30B of knowledge but only ~3B active per token, so it is fast and built for agentic tool calling",
  },
  {
    name: "devstral:24b",
    downloadGB: 14,
    needsRamGB: 32,
    why: "trained specifically to drive coding agents — multi-file edits and tool use rather than snippet completion",
  },
];

/**
 * What to tell the user about running the coder locally on THIS machine.
 * Returns null when the machine can comfortably host a recommended model.
 */
export function coderHardwareAdvice(totalMemoryBytes = os.totalmem()): string | null {
  const ramGB = totalMemoryBytes / 1.073741824e9;
  const affordable = RECOMMENDED_CODERS.filter((r) => ramGB >= r.needsRamGB);
  if (affordable.length) return null;
  const list = RECOMMENDED_CODERS.map(
    (r) => `${r.name} (~${r.downloadGB}GB download, needs ~${r.needsRamGB}GB RAM)`
  ).join(" or ");
  return (
    `This machine has ~${Math.round(ramGB)}GB RAM. The local models that can reliably drive ` +
    `WayCode's tools — ${list} — need more than that. Smaller coder models read your files and ` +
    `then fail to emit a valid edit, so the run finishes having changed nothing. ` +
    `For the coder role use the Anthropic or OpenAI API; keep a local model for the communicator, ` +
    `where it works well.`
  );
}
