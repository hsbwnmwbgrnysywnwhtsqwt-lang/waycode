/**
 * Shared HTTP helper for all providers: JSON POST with a hard timeout and
 * human-readable error messages. A timeout (rather than an indefinite hang) is
 * important for local models — Ollama can stall while loading a model into RAM.
 */

// Derive the response type from `fetch` itself so we never depend on a globally
// named `Response` type being present in the TS lib configuration.
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 300_000
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

/** Read an error response body safely for inclusion in an error message. */
export async function readError(res: FetchResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
}
