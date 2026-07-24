/**
 * Shared HTTP helper for all providers: JSON POST with a hard timeout, automatic
 * retries on transient failures, and human-readable error messages. A timeout
 * (rather than an indefinite hang) matters for local models — Ollama can stall
 * while loading a model into RAM.
 */

// Derive the response type from `fetch` itself so we never depend on a globally
// named `Response` type being present in the TS lib configuration.
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/** HTTP statuses worth retrying: rate limiting and transient server errors. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BASE_BACKOFF_MS = 400;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attemptPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<FetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s (${url}).`);
    }
    throw new Error(`Network error calling ${url}: ${e?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 300_000,
  retries = 2
): Promise<FetchResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await attemptPost(url, headers, body, timeoutMs);
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await delay(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      // A deliberate timeout is not worth retrying; other network errors are.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("timed out") || attempt === retries) {
        throw err;
      }
      await delay(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

/** Read an error response body safely for inclusion in an error message. */
export async function readError(res: FetchResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
}
