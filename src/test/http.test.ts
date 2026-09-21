import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { postJson, postJsonLines } from "../providers/http";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("postJson returns the response on success", async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  const res = await postJson("http://x/y", {}, { a: 1 });
  assert.equal(res.ok, true);
});

test("postJson wraps a network error with a readable message", async () => {
  globalThis.fetch = (async () => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  // retries=0 keeps this fast and focused on the error message.
  await assert.rejects(
    () => postJson("http://x/y", {}, {}, 30000, 0),
    /Network error calling http:\/\/x\/y: boom/
  );
});

test("postJson reports a timeout as an AbortError and does not retry", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }) as unknown as typeof fetch;
  await assert.rejects(() => postJson("http://x/y", {}, {}, 1000, 2), /timed out/);
  assert.equal(calls, 1, "timeout should not be retried");
});

/** A body that emits `lines`, pausing `gapMs` between each. */
function slowStream(lines: unknown[], gapMs: number): ReadableStream {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= lines.length) return controller.close();
      await new Promise((r) => setTimeout(r, gapMs));
      controller.enqueue(encoder.encode(JSON.stringify(lines[i++]) + "\n"));
    },
  });
}

test("postJsonLines delivers each NDJSON object in order", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    body: slowStream([{ n: 1 }, { n: 2 }, { n: 3 }], 0),
  })) as unknown as typeof fetch;

  const seen: unknown[] = [];
  await postJsonLines("http://x/y", {}, {}, (v) => seen.push(v));
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("postJsonLines tolerates objects split across chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const pieces = ['{"a"', ':1}\n{"b":', "2}\n"];
  let i = 0;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      pull(controller) {
        if (i >= pieces.length) return controller.close();
        controller.enqueue(encoder.encode(pieces[i++]));
      },
    }),
  })) as unknown as typeof fetch;

  const seen: unknown[] = [];
  await postJsonLines("http://x/y", {}, {}, (v) => seen.push(v));
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
});

test("postJsonLines keeps waiting while a slow model is still producing output", async () => {
  // Four chunks 60ms apart is 240ms total — well past the 100ms idle limit, but
  // never silent for that long. A total-time deadline would kill this run; the
  // whole point of the idle timer is that it must not.
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    body: slowStream([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], 60),
  })) as unknown as typeof fetch;

  const seen: unknown[] = [];
  await postJsonLines("http://x/y", {}, {}, (v) => seen.push(v), 100);
  assert.equal(seen.length, 4);
});

test("postJsonLines gives up once the stream actually goes silent", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    body: slowStream([{ n: 1 }, { n: 2 }], 300),
  })) as unknown as typeof fetch;

  await assert.rejects(
    () => postJsonLines("http://x/y", {}, {}, () => {}, 80),
    /stopped mid-reply/
  );
});

test("postJsonLines waits far longer for the first byte than between later ones", async () => {
  // A local model is silent while it loads and reads the prompt — 695s in the
  // worst case measured. That silence must not be judged by the between-token
  // limit, or the request dies just before its first token arrives.
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    body: slowStream([{ n: 1 }, { n: 2 }], 150),
  })) as unknown as typeof fetch;

  const seen: unknown[] = [];
  // Between-token limit of 400ms, first-byte allowance of 5s: the 150ms wait
  // before the first chunk is well inside the latter and nowhere near a stall.
  await postJsonLines("http://x/y", {}, {}, (v) => seen.push(v), 400, 5000);
  assert.equal(seen.length, 2);
});

test("postJsonLines reports a model that never starts replying at all", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    body: slowStream([{ n: 1 }], 500),
  })) as unknown as typeof fetch;

  await assert.rejects(
    () => postJsonLines("http://x/y", {}, {}, () => {}, 5000, 100),
    /never started replying/
  );
});

test("postJson retries a transient 503 then returns the eventual 200", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  const res = await postJson("http://x/y", {}, {}, 30000, 2);
  assert.equal(res.ok, true);
  assert.equal(calls, 2, "should retry once after the 503");
});
