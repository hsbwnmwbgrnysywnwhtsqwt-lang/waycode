import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseContextWindow,
  kvBytesPerToken,
  memoryCeiling,
  parseGeometry,
  MIN_CONTEXT_TOKENS,
} from "../providers/ollamaContext";

const GB = 1.073741824e9;

/** qwen2.5-coder:14b exactly as Ollama reports it. */
const QWEN14B = {
  contextLength: 32768,
  blockCount: 48,
  kvHeads: 8,
  headDim: 128,
  sizeBytes: 8_988_124_298,
};

test("KV cost per token matches the model's real geometry", () => {
  // 48 layers × (key + value) × 8 heads × 128 wide × 2 bytes.
  assert.equal(kvBytesPerToken(QWEN14B), 196_608);
  // ~1.5GB for an 8k window, ~6GB for 32k — the numbers that decide everything.
  assert.ok(Math.abs(kvBytesPerToken(QWEN14B)! * 8192 - 1.5 * GB) < 0.1 * GB);
  assert.ok(Math.abs(kvBytesPerToken(QWEN14B)! * 32768 - 6 * GB) < 0.2 * GB);
});

test("an unknown architecture yields no estimate rather than a guess", () => {
  assert.equal(kvBytesPerToken({ sizeBytes: 1e9 }), undefined);
  assert.equal(memoryCeiling({ sizeBytes: 1e9 }, 16 * GB), undefined);
});

test("the 16GB machine that timed out is held to a window it can actually fill", () => {
  // Measured on that machine, with a prompt large enough to OCCUPY the window:
  // 8k was healthy, 16k took 695s to produce its first token. An empty 16k cache
  // benchmarks fine, which is exactly why the ceiling cannot be set from that.
  const ceiling = memoryCeiling(QWEN14B, 16 * GB)!;
  assert.ok(ceiling >= 8192, `8k was measured as healthy, so it must stay allowed (got ${ceiling})`);
  assert.ok(ceiling < 16384, `a full 16k cache was measured as unusable here (got ${ceiling})`);
});

test("a machine with room to spare still gets the full trained window", () => {
  const choice = chooseContextWindow({
    needed: 60_000,
    geometry: QWEN14B,
    totalMemoryBytes: 64 * GB,
  });
  assert.equal(choice.tokens, 32768, "capped by the model, not by the machine");
});

test("a small request does not reserve a large window", () => {
  const choice = chooseContextWindow({ needed: 2000, geometry: QWEN14B, totalMemoryBytes: 64 * GB });
  assert.equal(choice.tokens, MIN_CONTEXT_TOKENS);
  assert.equal(choice.warning, undefined);
});

test("a prompt that will not fit is reported instead of being truncated in silence", () => {
  const choice = chooseContextWindow({
    needed: 120_000,
    geometry: QWEN14B,
    totalMemoryBytes: 16 * GB,
  });
  assert.ok(choice.tokens <= 16384);
  assert.match(choice.warning ?? "", /context/i);
});

test("a pinned window is obeyed even when it is a bad idea", () => {
  const choice = chooseContextWindow({
    needed: 100_000,
    geometry: QWEN14B,
    totalMemoryBytes: 16 * GB,
    pinned: 65536,
  });
  assert.equal(choice.tokens, 65536);
});

test("unknown geometry falls back to sizing from the request", () => {
  const choice = chooseContextWindow({ needed: 20_000, geometry: {}, totalMemoryBytes: 16 * GB });
  assert.equal(choice.tokens, 32768);
});

test("geometry is read from any architecture's namespaced keys", () => {
  const g = parseGeometry({
    model_info: {
      "llama.context_length": 8192,
      "llama.block_count": 32,
      "llama.attention.head_count": 32,
      "llama.attention.head_count_kv": 8,
      "llama.embedding_length": 4096,
    },
  });
  assert.deepEqual(g, { contextLength: 8192, blockCount: 32, kvHeads: 8, headDim: 128 });
});

test("a model without grouped-query attention falls back to its query heads", () => {
  const g = parseGeometry({
    model_info: {
      "gemma2.block_count": 26,
      "gemma2.attention.head_count": 8,
      "gemma2.embedding_length": 2048,
    },
  });
  assert.equal(g.kvHeads, 8);
  assert.equal(g.headDim, 256);
});

test("weights that already exhaust the machine still get a usable window", () => {
  const huge = { ...QWEN14B, sizeBytes: 40 * GB };
  assert.equal(memoryCeiling(huge, 16 * GB), MIN_CONTEXT_TOKENS);
});
