import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEditBlocks, editBlocksToToolCalls } from "../agent/editBlocks";

test("a plain SEARCH/REPLACE block is parsed with its file path", () => {
  const reply = `I'll add the card.

index.html
<<<<<<< SEARCH
  <div class="project-card">
    <div class="project-name">Old</div>
=======
  <div class="project-card">
    <div class="project-name">Test</div>
>>>>>>> REPLACE`;
  const blocks = parseEditBlocks(reply);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "index.html");
  assert.match(blocks[0].search, /project-name">Old/);
  assert.match(blocks[0].replace, /project-name">Test/);
});

test("several blocks in one reply each keep their own path", () => {
  const reply = `README.md
<<<<<<< SEARCH
# Old
=======
# New
>>>>>>> REPLACE

src/app.js
<<<<<<< SEARCH
const a = 1;
=======
const a = 2;
>>>>>>> REPLACE`;
  const blocks = parseEditBlocks(reply);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, "README.md");
  assert.equal(blocks[1].path, "src/app.js");
});

test("marker length, backticked paths and CRLF are all tolerated", () => {
  const reply = "`src/index.html`\r\n<<<<<< SEARCH\r\n<p>a</p>\r\n======\r\n<p>b</p>\r\n>>>>>> REPLACE";
  const blocks = parseEditBlocks(reply);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "src/index.html");
  assert.equal(blocks[0].search, "<p>a</p>");
  assert.equal(blocks[0].replace, "<p>b</p>");
});

test("blocks become ordinary edit_file tool calls", () => {
  const blocks = parseEditBlocks(`app.css
<<<<<<< SEARCH
body { color: red; }
=======
body { color: blue; }
>>>>>>> REPLACE`);
  const calls = editBlocksToToolCalls(blocks);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "edit_file");
  assert.equal(calls[0].input.path, "app.css");
  assert.equal(calls[0].input.old_text, "body { color: red; }");
  assert.equal(calls[0].input.new_text, "body { color: blue; }");
});

test("an empty SEARCH means create the file", () => {
  const blocks = parseEditBlocks(`new.md
<<<<<<< SEARCH
=======
# Hello
>>>>>>> REPLACE`);
  const calls = editBlocksToToolCalls(blocks);
  assert.equal(calls[0].name, "create_file");
  assert.equal(calls[0].input.content, "# Hello");
});

test("a block with no path falls back to the file the model just read", () => {
  const blocks = parseEditBlocks(`<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE`);
  assert.equal(blocks[0].path, undefined);
  const calls = editBlocksToToolCalls(blocks, "index.html");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.path, "index.html");
});

test("with no path anywhere, nothing is applied rather than guessed", () => {
  const blocks = parseEditBlocks("<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE");
  assert.deepEqual(editBlocksToToolCalls(blocks), []);
});

test("ordinary prose and code fences are never mistaken for edits", () => {
  assert.deepEqual(parseEditBlocks("Here is the plan:\n1. read\n2. edit"), []);
  assert.deepEqual(parseEditBlocks("```js\nconst a = 1;\n```"), []);
  assert.deepEqual(parseEditBlocks(""), []);
});

test("indentation inside the block is preserved exactly", () => {
  const blocks = parseEditBlocks(`f.py
<<<<<<< SEARCH
def a():
    return 1
=======
def a():
    return 2
>>>>>>> REPLACE`);
  assert.equal(blocks[0].search, "def a():\n    return 1");
  assert.equal(blocks[0].replace, "def a():\n    return 2");
});

test("later blocks inherit the file named once above the first block", () => {
  // A model naming the file once then emitting several edits for it meant all of
  // them for that file; without inheritance the rest hit a DIFFERENT file.
  const blocks = parseEditBlocks(`a.js
<<<<<<< SEARCH
1
=======
2
>>>>>>> REPLACE
<<<<<<< SEARCH
3
=======
4
>>>>>>> REPLACE`);
  const calls = editBlocksToToolCalls(blocks, "unrelated.txt");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.input.path), ["a.js", "a.js"]);
});

test("a later block that DOES name its own file still wins", () => {
  const blocks = parseEditBlocks(`a.js
<<<<<<< SEARCH
1
=======
2
>>>>>>> REPLACE

b.js
<<<<<<< SEARCH
3
=======
4
>>>>>>> REPLACE`);
  const calls = editBlocksToToolCalls(blocks);
  assert.deepEqual(calls.map((c) => c.input.path), ["a.js", "b.js"]);
});

test("an unterminated block is ignored rather than half-applied", () => {
  assert.deepEqual(parseEditBlocks("a.js\n<<<<<<< SEARCH\na\n=======\nb"), []);
});
