import * as os from "os";

/**
 * Choosing `num_ctx` for a local model is not a "bigger is better" decision. It
 * is a memory decision, and getting it wrong is the difference between a reply
 * in seconds and a reply that never arrives at all.
 *
 * Measured on an M2 / 16GB running qwen2.5-coder:14b (9.0GB of weights):
 *
 *   num_ctx=8192    KV cache 1.5GB   →  7.9 tok/s
 *   num_ctx=16384   KV cache 3.0GB   →  8.4 tok/s
 *   num_ctx=32768   KV cache 6.0GB   →  0.12 tok/s  (~8 SECONDS per token)
 *
 * Nothing hangs and nothing errors. The weights plus the KV cache simply stop
 * fitting in the GPU's working set, inference falls back to the CPU, and a
 * normal-length answer can no longer finish inside any sane timeout — the run
 * dies on a request timeout that looks like a broken connection but is really a
 * model crawling at a twentieth of walking pace.
 *
 * Sizing the window from the size of the prompt alone walks straight into this:
 * attaching one large file pushes the request over the cliff, and every later
 * turn in that conversation inherits the collapse.
 *
 * One trap in those numbers, worth stating because it cost an afternoon:
 * ALLOCATING a window is not the same as FILLING it. The 16k row above was
 * measured with a short prompt, so the cache was reserved but barely touched,
 * and it looked healthy. Re-measured with a 14k-token prompt that actually
 * occupies the window, the same configuration took 695 seconds to produce its
 * first token. So the budget below has to cover a FULL cache, not an empty one —
 * which is why it is stricter than the fast-looking measurements suggest.
 *
 * So the window is chosen from three limits, smallest wins:
 *   1. what the request actually needs,
 *   2. what the model was trained for (asking for more buys nothing),
 *   3. what this machine can hold on the GPU alongside the weights.
 */

/** KV cache entries are fp16 — two bytes per element. */
const KV_BYTES_PER_ELEMENT = 2;

/**
 * Fraction of system memory the weights plus a FULL KV cache may occupy before
 * inference stops fitting on the GPU.
 *
 * Calibrated against the measurements above rather than guessed. On the 16GB
 * machine: 10.5GB (weights + a full 8k cache) works, 12.0GB (a full 16k cache)
 * does not — that is the configuration that took 695s to first token. So the
 * real boundary sits between 0.66 and 0.75, and 0.70 is the value that keeps
 * the working case and rejects the one that collapses.
 *
 * Erring low is deliberate: too small a window drops old turns, which is
 * annoying and visible. Too large a window makes the model appear to hang for
 * ten minutes, which is indistinguishable from a crash.
 */
const MEMORY_BUDGET = 0.7;

/**
 * Never go below this. Ollama's own default is ~4k and it silently truncates
 * past it, which costs the agent its tool definitions — a failure far worse
 * than being slow, because it is invisible.
 */
export const MIN_CONTEXT_TOKENS = 8192;

/**
 * The only windows we are willing to ask for.
 *
 * Ollama reloads the model whenever `num_ctx` changes — 63 seconds of dead time
 * on the machine above, spent before a single token is generated. Moving
 * between a handful of fixed sizes instead of tracking the prompt exactly keeps
 * those reloads rare.
 */
const BUCKETS = [8192, 16384, 32768, 65536, 131072];

/** What we need to know about a model to size its context window. */
export interface ModelGeometry {
  /** Max context the model was trained for. Asking for more wastes memory. */
  contextLength?: number;
  /** Transformer layers. */
  blockCount?: number;
  /** Key/value heads (GQA models have far fewer of these than query heads). */
  kvHeads?: number;
  /** Width of one attention head. */
  headDim?: number;
  /** On-disk size of the weights, which is what they cost in memory. */
  sizeBytes?: number;
}

/**
 * Memory one token of context costs, across every layer, for keys and values.
 * Undefined when the model's geometry is unknown — callers then fall back to
 * the model's own context length rather than inventing a number.
 */
export function kvBytesPerToken(g: ModelGeometry): number | undefined {
  if (!g.blockCount || !g.kvHeads || !g.headDim) return undefined;
  return g.blockCount * 2 * g.kvHeads * g.headDim * KV_BYTES_PER_ELEMENT;
}

/**
 * Largest window whose KV cache still fits beside the weights on this machine.
 * Undefined when we cannot tell, so the caller can skip the memory limit rather
 * than apply a made-up one.
 */
export function memoryCeiling(
  g: ModelGeometry,
  totalMemoryBytes = os.totalmem()
): number | undefined {
  const perToken = kvBytesPerToken(g);
  if (!perToken || !g.sizeBytes) return undefined;
  const spare = totalMemoryBytes * MEMORY_BUDGET - g.sizeBytes;
  // Weights alone already blow the budget: nothing will run well, so ask for
  // the smallest useful window and let the caller warn about the machine.
  if (spare <= 0) return MIN_CONTEXT_TOKENS;
  return Math.floor(spare / perToken);
}

/** Round down to a bucket, never below the minimum usable window. */
function toBucket(tokens: number): number {
  let chosen = MIN_CONTEXT_TOKENS;
  for (const b of BUCKETS) {
    if (b <= tokens) chosen = b;
  }
  return chosen;
}

/** Round up to a bucket, so a request is not truncated for the sake of tidiness. */
function bucketAtLeast(tokens: number): number {
  for (const b of BUCKETS) {
    if (tokens <= b) return b;
  }
  return BUCKETS[BUCKETS.length - 1];
}

export interface ContextChoice {
  tokens: number;
  /** Set when the request will not fit — the user needs to know, not guess. */
  warning?: string;
}

/**
 * Pick `num_ctx` for one request.
 *
 * `pinned` (the user's `waycode.ollama.contextTokens` setting) is obeyed as
 * written, including when it is a bad idea: an explicit setting exists so a
 * user who knows their hardware can overrule us.
 */
export function chooseContextWindow(opts: {
  /** Tokens the prompt actually needs, reply included. */
  needed: number;
  geometry: ModelGeometry;
  totalMemoryBytes?: number;
  pinned?: number;
}): ContextChoice {
  const { needed, geometry, pinned } = opts;
  if (pinned && pinned > 0) return { tokens: pinned };

  const wanted = bucketAtLeast(Math.max(needed, MIN_CONTEXT_TOKENS));

  // Limit 2: the model's trained context.
  const trained = geometry.contextLength;
  // Limit 3: what this machine can actually hold.
  const affordable = memoryCeiling(geometry, opts.totalMemoryBytes);

  let ceiling = Infinity;
  if (trained) ceiling = Math.min(ceiling, trained);
  if (affordable) ceiling = Math.min(ceiling, affordable);

  if (!Number.isFinite(ceiling)) return { tokens: wanted };

  const tokens = Math.min(wanted, toBucket(ceiling));
  if (tokens >= needed) return { tokens };

  // The prompt does not fit. Ollama would truncate it silently, taking the tool
  // definitions or the attached file with it, and the run would fail in a way
  // that looks like the model being stupid. Say so instead.
  const limit =
    affordable !== undefined && affordable < (trained ?? Infinity)
      ? `this machine can only run a ${Math.round(tokens / 1024)}k window with this model without falling back to the CPU`
      : `the model tops out at a ${Math.round(tokens / 1024)}k window`;
  return {
    tokens,
    warning:
      `This request needs about ${Math.round(needed / 1024)}k tokens of context but ${limit}. ` +
      `The oldest part of the conversation will be dropped. Attach a smaller file, or use a ` +
      `smaller model so the same memory buys a bigger window.`,
  };
}

/**
 * Windows already used this session, so the choice never shrinks mid-conversation.
 *
 * A window that grows and shrinks as history comes and goes makes Ollama reload
 * the model on every change. Holding the high-water mark trades a little unused
 * memory for not paying that reload repeatedly.
 */
const highWater = new Map<string, number>();

/** Raise the remembered window for a model and return the value to request. */
export function stickyWindow(key: string, tokens: number): number {
  const previous = highWater.get(key) ?? 0;
  const chosen = Math.max(previous, tokens);
  highWater.set(key, chosen);
  return chosen;
}

/** Test seam — the high-water marks are process-global otherwise. */
export function resetStickyWindows(): void {
  highWater.clear();
}

interface ShowResponse {
  model_info?: Record<string, unknown>;
}

interface TagsResponse {
  models?: Array<{ name?: string; size?: number; details?: { context_length?: number } }>;
}

/** Geometry is a property of the model file and never changes while it exists. */
const geometryCache = new Map<string, ModelGeometry>();

/**
 * Ask Ollama about a model's shape. Every field is optional and a failure is not
 * fatal: an unknown model just means we fall back to the request-sized window,
 * which is what this code did for every model before.
 *
 * The two endpoints carry different halves of the answer — `/api/show` knows the
 * architecture, `/api/tags` knows the size on disk — so we read both.
 */
export async function fetchModelGeometry(
  baseUrl: string,
  model: string,
  timeoutMs = 5_000
): Promise<ModelGeometry> {
  const cacheKey = `${baseUrl}::${model}`;
  const cached = geometryCache.get(cacheKey);
  if (cached) return cached;

  const geometry: ModelGeometry = {};
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) Object.assign(geometry, parseGeometry((await res.json()) as ShowResponse));
  } catch {
    // Leave the fields undefined; the caller degrades gracefully.
  }

  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const data = (await res.json()) as TagsResponse;
      const entry = data.models?.find((m) => m.name === model);
      if (entry?.size) geometry.sizeBytes = entry.size;
      if (!geometry.contextLength && entry?.details?.context_length) {
        geometry.contextLength = entry.details.context_length;
      }
    }
  } catch {
    // As above.
  }

  geometryCache.set(cacheKey, geometry);
  return geometry;
}

/**
 * Pull the architecture out of `/api/show`.
 *
 * The keys are namespaced by architecture ("qwen2.block_count", "llama.block_count"),
 * so we match on the suffix rather than enumerating every model family that
 * exists — a new architecture should work on the day it ships.
 */
export function parseGeometry(data: ShowResponse): ModelGeometry {
  const info = data.model_info ?? {};
  const num = (suffix: string): number | undefined => {
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith(suffix) && typeof v === "number" && v > 0) return v;
    }
    return undefined;
  };

  const headCount = num(".attention.head_count");
  const embedding = num(".embedding_length");
  // Most GGUF models state the head width outright; the rest imply it.
  const headDim =
    num(".attention.key_length") ??
    (headCount && embedding ? Math.floor(embedding / headCount) : undefined);

  return {
    contextLength: num(".context_length"),
    blockCount: num(".block_count"),
    kvHeads: num(".attention.head_count_kv") ?? headCount,
    headDim,
  };
}

/** Test seam. */
export function resetGeometryCache(): void {
  geometryCache.clear();
}
