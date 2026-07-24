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
  await assert.rejects(() => postJson("http://x/y", {}, {}), /Network error calling http:\/\/x\/y: boom/);
});

test("postJson reports a timeout as an AbortError", async () => {
  globalThis.fetch = (async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }) as unknown as typeof fetch;
  await assert.rejects(() => postJson("http://x/y", {}, {}, 1000), /timed out/);
});
