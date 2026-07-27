import { test } from "node:test";
import assert from "node:assert/strict";
import { specTargets, untouchedTargets } from "../agent/Orchestrator";

const SPEC = `Goal: Create the project documentation and a landing page.
Search terms: waycode, README, generativelanguage.googleapis.com, "@google/generative-ai"
Deliverables: README.md
index.html
Details/constraints: plain HTML, no framework.
Acceptance criteria: both files exist.`;

test("the spec's deliverable files are extracted", () => {
  const targets = specTargets(SPEC);
  assert.ok(targets.includes("README.md"));
  assert.ok(targets.includes("index.html"));
});

test("grep needles on the Search terms line are not mistaken for deliverables", () => {
  const targets = specTargets(SPEC);
  assert.ok(
    !targets.some((t) => t.includes("googleapis")),
    "a hostname is a search term, not a file to produce"
  );
  assert.ok(!targets.some((t) => t.includes("generative-ai")));
});

test("version numbers and unknown extensions are ignored", () => {
  assert.deepEqual(specTargets("Goal: bump to 1.2.4 and check example.com"), []);
});

test("a deliverable no tool ever touched is reported as unfinished", () => {
  // The exact failure the user hit: the README got written, the HTML page did not.
  const actions = ["changed: create_file README.md → ok"];
  assert.deepEqual(untouchedTargets(SPEC, actions), ["index.html"]);
});

test("nothing is reported once every deliverable has been touched", () => {
  const actions = [
    "changed: create_file README.md → ok",
    "changed: create_file index.html → ok",
  ];
  assert.deepEqual(untouchedTargets(SPEC, actions), []);
});

test("a deliverable is matched by basename regardless of path prefix", () => {
  const spec = "Goal: build the page.\nDeliverables: src/pages/index.html";
  assert.deepEqual(untouchedTargets(spec, ["changed: create_file ./src/pages/index.html → ok"]), []);
});

test("a failed write still counts as touched, so the coder is not nudged twice", () => {
  const actions = [
    "changed: create_file README.md → ok",
    "attempted-change: create_file index.html → ERROR: denied by user",
  ];
  assert.deepEqual(untouchedTargets(SPEC, actions), []);
});

test("merely SEARCHING for a deliverable does not count as producing it", () => {
  // The real failure: the coder grepped for index.html, found nothing, and gave
  // up. Counting the search as "touched" silently suppressed the nudge.
  const actions = [
    "read: search_code /index.html/ → ok",
    "read: search_code /project-card/ → ok",
    "changed: create_file README.md → ok",
  ];
  assert.deepEqual(untouchedTargets(SPEC, actions), ["index.html"]);
});

test("reading a deliverable is not the same as writing it", () => {
  const actions = ["read: read_file index.html → ok", "changed: create_file README.md → ok"];
  assert.deepEqual(untouchedTargets(SPEC, actions), ["index.html"]);
});

test("a reference file outside the Deliverables section is never demanded", () => {
  // "model it on tikunchik.html" must not be read as "you must write tikunchik.html".
  const spec = `Goal: Build a WayCode page.
Deliverables: waycode.html
Details/constraints: structure it exactly like tikunchik.html, reuse style.css.
Acceptance criteria: waycode.html renders.`;
  assert.deepEqual(specTargets(spec), ["waycode.html"]);
  assert.deepEqual(untouchedTargets(spec, ["changed: create_file waycode.html → ok"]), []);
});
