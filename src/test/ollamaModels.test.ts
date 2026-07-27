import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeModel,
  parseBillions,
  formatSpecs,
  fitIcon,
  coderHardwareAdvice,
  RECOMMENDED_CODERS,
} from "../providers/ollamaModels";

const GB = 1e9;
const RAM_16 = 16 * 1.073741824 * GB;

function entry(over: Record<string, unknown> = {}) {
  return {
    name: "qwen2.5-coder:14b",
    size: 9 * GB,
    capabilities: ["completion", "tools", "insert"],
    details: {
      family: "qwen2",
      parameter_size: "14.8B",
      quantization_level: "Q4_K_M",
      context_length: 32768,
    },
    ...over,
  };
}

test("a real installed model is fully identified from the scan", () => {
  const m = describeModel(entry(), RAM_16);
  assert.equal(m.name, "qwen2.5-coder:14b");
  assert.equal(m.parameterSize, "14.8B");
  assert.equal(m.parameterBillions, 14.8);
  assert.equal(m.quantization, "Q4_K_M");
  assert.equal(m.contextLength, 32768);
  assert.equal(m.supportsTools, true);
  assert.equal(formatSpecs(m), "9.0 GB · 14.8B · Q4_K_M · 32k ctx");
});

test("a model with no tool support can never be the coder", () => {
  // gemma2 is exactly this case: fine as communicator, cannot call a single tool.
  const m = describeModel(
    entry({ name: "gemma2:9b", capabilities: ["completion"], details: { parameter_size: "9.2B" } }),
    RAM_16
  );
  assert.equal(m.supportsTools, false);
  assert.equal(m.coderFit, "unusable");
  assert.match(m.note, /no tool support/);
  assert.equal(fitIcon(m.coderFit), "⛔");
});

test("a model below the reliability threshold is flagged as weak", () => {
  // The measured failure from this project: 7b emits truncated tool JSON.
  const m = describeModel(
    entry({ name: "qwen2.5-coder:7b", size: 4.7 * GB, details: { parameter_size: "7.6B", context_length: 32768 } }),
    RAM_16
  );
  assert.equal(m.coderFit, "weak");
  assert.match(m.note, /too small to edit files reliably/);
});

test("a tiny context window disqualifies a model regardless of size", () => {
  const m = describeModel(
    entry({ details: { parameter_size: "14.8B", context_length: 4096 } }),
    RAM_16
  );
  assert.equal(m.coderFit, "weak");
  assert.match(m.note, /too small for real files/);
});

test("a model too large for this machine is marked marginal, not good", () => {
  const m = describeModel(entry({ size: 18 * GB, details: { parameter_size: "32B", context_length: 32768 } }), RAM_16);
  assert.equal(m.heavyForThisMachine, true);
  assert.equal(m.coderFit, "marginal");
  assert.match(m.note, /RAM/);
});

test("a large model that fits is a good coder", () => {
  const big = 64 * 1.073741824 * GB;
  const m = describeModel(entry({ size: 20 * GB, details: { parameter_size: "32B", context_length: 32768 } }), big);
  assert.equal(m.coderFit, "good");
  assert.equal(fitIcon(m.coderFit), "✅");
});

test("parameter sizes are parsed in both B and M units", () => {
  assert.equal(parseBillions("14.8B"), 14.8);
  assert.equal(parseBillions("7B"), 7);
  assert.equal(parseBillions("500M"), 0.5);
  assert.equal(parseBillions(undefined), undefined);
  assert.equal(parseBillions("weird"), undefined);
});

test("missing details degrade gracefully instead of throwing", () => {
  const m = describeModel({ name: "mystery:latest" }, RAM_16);
  assert.equal(m.name, "mystery:latest");
  assert.equal(m.supportsTools, false);
  assert.equal(m.coderFit, "unusable");
  assert.equal(formatSpecs(m), "");
});

test("a 16GB machine is told plainly that no local coder will do", () => {
  const advice = coderHardwareAdvice(16 * 1.073741824e9);
  assert.ok(advice, "advice is required on a machine this size");
  assert.match(advice!, /16GB RAM/);
  assert.match(advice!, /qwen3-coder:30b/);
  assert.match(advice!, /devstral:24b/);
  assert.match(advice!, /Anthropic or OpenAI API/);
});

test("a 64GB machine gets no warning — it can host a recommended model", () => {
  assert.equal(coderHardwareAdvice(64 * 1.073741824e9), null);
});

test("exactly two coder models are recommended, both with real requirements", () => {
  assert.equal(RECOMMENDED_CODERS.length, 2);
  for (const r of RECOMMENDED_CODERS) {
    assert.ok(r.name && r.why);
    assert.ok(r.downloadGB > 0 && r.needsRamGB > 0);
  }
});
