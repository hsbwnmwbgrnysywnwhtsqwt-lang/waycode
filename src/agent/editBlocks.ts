import { ToolCall } from "../providers/types";

/**
 * One SEARCH/REPLACE edit recovered from a model's plain text.
 *
 * WHY THIS EXISTS
 * ---------------
 * Small local coder models cannot reliably emit a tool call for an edit. Measured
 * on this project with qwen2.5-coder: asked to add a card to a 495-line HTML file,
 * the model produces `{"name":"edit_file","arguments":{"path":...,"old_text":"",`
 * and then breaks — the JSON truncates around 990 characters because the snippet
 * it must embed is full of quotes that need escaping, and `old_text` comes back
 * empty anyway. The result the user sees is "the agent read the file and changed
 * nothing".
 *
 * The same models are perfectly good at emitting SEARCH/REPLACE blocks, because
 * that is the diff format they were trained on. No escaping, no nesting, no
 * balanced braces — just literal lines between markers. So we accept that format
 * as a first-class way to edit, translate it into ordinary `edit_file` calls, and
 * every existing guarantee (diff preview, approval, path safety) still applies.
 */
export interface EditBlock {
  /** Workspace-relative path, when the model named one above the block. */
  path?: string;
  /** Text to find. Empty means "append to the end of the file". */
  search: string;
  /** Text to put in its place. */
  replace: string;
}

/**
 * Matches the block form, tolerating the variations models actually produce:
 * marker runs of any length (`<<<<` … `<<<<<<<<`), an optional language or path
 * after the SEARCH keyword, `\r\n`, and a missing trailing newline.
 */
const BLOCK = /^[ \t]*<{3,}[ \t]*SEARCH[^\n]*\n([\s\S]*?)^[ \t]*={3,}[ \t]*\n([\s\S]*?)^[ \t]*>{3,}[ \t]*REPLACE[^\n]*$/gm;

/**
 * A path named on its own line just before a block: bare, in backticks, in a
 * comment, or prefixed with "File:". Anything with a dot and no spaces.
 */
const PATH_LINE = /(?:^|\n)[ \t]*(?:File:[ \t]*|#+[ \t]*)?[`'"]?([\w./\\-]+\.[A-Za-z][\w]{0,7})[`'"]?[ \t]*:?[ \t]*(?:\n|$)/;

/** Extract every SEARCH/REPLACE block from a model's message. */
export function parseEditBlocks(text: string): EditBlock[] {
  if (!text || !/<{3,}[ \t]*SEARCH/i.test(text)) return [];
  const source = text.replace(/\r\n/g, "\n");
  const blocks: EditBlock[] = [];
  let lastIndex = 0;
  BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK.exec(source)) !== null) {
    // The path, if given, is on a line in the gap since the previous block.
    const preamble = source.slice(lastIndex, m.index);
    const pathMatch = [...preamble.matchAll(new RegExp(PATH_LINE, "g"))].pop();
    blocks.push({
      path: pathMatch?.[1],
      search: stripTrailingNewline(m[1]),
      replace: stripTrailingNewline(m[2]),
    });
    lastIndex = m.index + m[0].length;
  }
  return blocks;
}

/**
 * Turn recovered blocks into the tool calls the agent already knows how to run,
 * so they go through diff preview, approval and path safety unchanged.
 *
 * `fallbackPath` is the file the model most recently read — models routinely omit
 * the path when the conversation has only touched one file.
 */
export function editBlocksToToolCalls(blocks: EditBlock[], fallbackPath?: string): ToolCall[] {
  const calls: ToolCall[] = [];
  // A model that names the file once and then emits several blocks for it means
  // all of them for that file. Without carrying the path forward, the second and
  // later edits would land on `fallbackPath` — a DIFFERENT file.
  let lastPath: string | undefined;
  blocks.forEach((b, i) => {
    const path = b.path ?? lastPath ?? fallbackPath;
    if (!path) return; // Nothing we could safely apply this to.
    lastPath = path;
    calls.push({
      id: `editblock-${Date.now()}-${i}`,
      name: b.search.trim() ? "edit_file" : "create_file",
      input: b.search.trim()
        ? { path, old_text: b.search, new_text: b.replace }
        : { path, content: b.replace },
    });
  });
  return calls;
}

function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/**
 * The part of the system prompt that teaches the format. Given to every model:
 * strong models keep using native tool calls (they are better), weak ones now
 * have a route that works instead of failing silently.
 */
export const EDIT_BLOCK_INSTRUCTIONS = `
## If you cannot produce a tool call for an edit
Never give up on an edit and never ask the user to paste the file back to you.
If emitting the edit_file tool call is failing, write the edit as a SEARCH/REPLACE
block instead — WayCode applies these exactly like a tool call, with the same diff
preview and approval:

path/to/file.ext
<<<<<<< SEARCH
(lines copied EXACTLY from the file, including indentation)
=======
(the replacement lines)
>>>>>>> REPLACE

Rules:
- Name the file on its own line immediately above the block.
- The SEARCH text must appear in the file character for character, and must be
  unique — include 3-8 lines of surrounding context to make it so.
- Leave SEARCH empty to create a new file with the REPLACE text as its content.
- Emit one block per edit. Never wrap blocks in a code fence.
`;
