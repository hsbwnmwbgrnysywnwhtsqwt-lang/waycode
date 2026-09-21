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

/**
 * POST and consume a newline-delimited JSON stream, calling `onLine` for each
 * object as it arrives.
 *
 * The timeout here is deliberately an IDLE timeout, not a total one. A local 14B
 * model can legitimately spend several minutes on a long answer; killing it at a
 * fixed wall-clock deadline throws away work that was progressing perfectly
 * well, which is exactly how a slow-but-healthy run ends up reported as a
 * network failure. What actually signals trouble is silence — no bytes at all —
 * so that is what we measure, restarting the clock on every chunk received.
 *
 * The wait for the FIRST byte gets its own, far longer budget. Before a local
 * model emits anything it has to be loaded into memory and then read the entire
 * prompt, and it sends nothing at all while doing so — measured at 695 seconds
 * for a 14k-token prompt on a 16GB machine. That silence is the model working,
 * not the model stuck, and treating it like a stall is how a request that would
 * have succeeded gets killed a few seconds before its first token.
 */
export async function postJsonLines(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  onLine: (value: unknown) => void,
  idleTimeoutMs = 120_000,
  firstByteTimeoutMs = 900_000
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wentQuiet = false;

  // The stall has to be raised as a rejection we race against, not just an
  // abort: aborting frees the socket but does not necessarily unblock a read
  // already waiting on it, and a timeout that cannot interrupt the thing it is
  // timing is no timeout at all.
  let raiseStall: (() => void) | undefined;
  const stalled = new Promise<never>((_, reject) => {
    raiseStall = () => reject(new Error("idle"));
  });
  // Nothing may await `stalled` once the stream finishes normally, and an
  // unobserved rejection would take the process down.
  stalled.catch(() => {});

  // Restart the silence clock. Called once before the request and again on
  // every chunk, so only a genuine stall can trip it. Until the first byte
  // lands, the generous budget applies.
  let seenFirstByte = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    const budget = seenFirstByte ? idleTimeoutMs : firstByteTimeoutMs;
    timer = setTimeout(() => {
      wentQuiet = true;
      controller.abort();
      raiseStall?.();
    }, budget);
  };
  arm();

  try {
    const res = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      stalled,
    ]);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await readError(res)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error(`No response body from ${url}.`);
    const decoder = new TextDecoder();
    let buffered = "";

    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stalled]);
      if (done) break;
      seenFirstByte = true;
      arm();
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        emit(buffered.slice(0, newline), onLine);
        buffered = buffered.slice(newline + 1);
      }
    }
    emit(buffered, onLine);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (wentQuiet || e?.name === "AbortError") {
      const waited = Math.round((seenFirstByte ? idleTimeoutMs : firstByteTimeoutMs) / 1000);
      const phase = seenFirstByte ? "stopped mid-reply" : "never started replying";
      throw new Error(
        `${url} ${phase} — nothing received for ${waited}s. ` +
          `The model is most likely too large for this machine at the requested context size — ` +
          `try a smaller model, or pin a smaller context window in WayCode's settings.`
      );
    }
    if (e?.message?.startsWith("HTTP ") || e?.message?.startsWith("No response body")) throw err;
    throw new Error(`Network error calling ${url}: ${e?.message ?? String(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Hand one NDJSON line to the consumer, ignoring blank or malformed lines. */
function emit(line: string, onLine: (value: unknown) => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    onLine(JSON.parse(trimmed));
  } catch {
    // A partial or non-JSON line is not worth failing the whole stream over.
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
