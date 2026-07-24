import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { postJson } from "../providers/http";

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
