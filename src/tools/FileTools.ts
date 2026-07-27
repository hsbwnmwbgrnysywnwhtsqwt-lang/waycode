import * as fs from "fs/promises";
import * as path from "path";
import { Tool, ToolContext, ToolPreview, ToolRunResult } from "./Tool";
import { safeResolve, toRelative } from "./pathUtils";
import { makeDiff } from "./diff";

const MAX_READ_BYTES = 200_000;

/** Read a file's contents. */
export class FileReadTool implements Tool {
  readonly name = "read_file";
  readonly description =
    "Read a text file. Pass offset/limit to read just part of a large file instead of the whole thing.";
  readonly risk = "read" as const;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the file." },
      offset: { type: "number", description: "1-based line to start at (default 1)." },
      limit: { type: "number", description: "How many lines to read from offset." },
    },
    required: ["path"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const rel = String(input.path ?? "");
    const abs = safeResolve(ctx.workspaceRoot, rel);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_READ_BYTES) {
      return { output: `File is too large (${stat.size} bytes). Read it in smaller ranges.`, isError: true };
    }
    const content = await fs.readFile(abs, "utf8");
    const lines = content.split("\n");

    // Paging matters most for the models that need it most: a small local model
    // handed 500 lines loses the thread, but can work through slices.
    const hasRange = input.offset !== undefined || input.limit !== undefined;
    if (!hasRange) {
      ctx.log(`📖 Read ${rel} (${lines.length} lines)`);
      return { output: content };
    }
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Math.max(1, Number(input.limit) || lines.length);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (!slice.length) {
      return {
        output: `'${rel}' has ${lines.length} lines; offset ${offset} is past the end.`,
        isError: true,
      };
    }
    const last = offset + slice.length - 1;
    ctx.log(`📖 Read ${rel} (lines ${offset}-${last} of ${lines.length})`);
    // Numbering the lines makes a follow-up range request unambiguous.
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
    const more = last < lines.length ? `\n… ${lines.length - last} more lines (read from ${last + 1})` : "";
    return { output: `${rel} lines ${offset}-${last} of ${lines.length}:\n${numbered}${more}` };
  }
}

/** Create a new file (fails if it already exists). */
export class FileCreateTool implements Tool {
  readonly name = "create_file";
  readonly description = "Create a NEW file with the given content. Fails if the file already exists.";
  readonly risk = "write" as const;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path for the new file." },
      content: { type: "string", description: "Full content of the new file." },
    },
    required: ["path", "content"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const rel = String(input.path ?? "");
    const content = String(input.content ?? "");
    const abs = safeResolve(ctx.workspaceRoot, rel);

    if (await exists(abs)) {
      return { output: `File '${rel}' already exists. Use edit_file to modify it.`, isError: true };
    }

    const preview = { title: `Create ${rel}`, diff: makeDiff("", content, rel) };
    if (!(await ctx.requestApproval(preview))) {
      return { output: "User rejected the file creation.", isError: true };
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    ctx.log(`✅ Created ${rel}`);
    return { output: `Created '${rel}'.`, preview };
  }
}

/** Overwrite the full contents of an existing file. */
export class FileWriteTool implements Tool {
  readonly name = "write_file";
  readonly description = "Overwrite an existing file with new full content. Prefer edit_file for small changes.";
  readonly risk = "write" as const;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the file." },
      content: { type: "string", description: "New full content of the file." },
    },
    required: ["path", "content"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const rel = String(input.path ?? "");
    const content = String(input.content ?? "");
    const abs = safeResolve(ctx.workspaceRoot, rel);
    const before = (await exists(abs)) ? await fs.readFile(abs, "utf8") : "";

    const preview = {
      title: `Write ${rel}`,
      diff: makeDiff(before, content, rel),
      destructive: isDestructiveOverwrite(before, content),
    };
    if (!(await ctx.requestApproval(preview))) {
      return { output: "User rejected the file write.", isError: true };
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    ctx.log(`✅ Wrote ${rel}`);
    return { output: `Wrote '${rel}'.`, preview };
  }
}

/** Replace an exact substring in a file (a targeted edit). */
export class FileEditTool implements Tool {
  readonly name = "edit_file";
  readonly description =
    "Make a targeted edit by replacing an exact unique snippet of text with new text. The old_text must appear exactly once.";
  readonly risk = "write" as const;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the file." },
      old_text: { type: "string", description: "Exact text to replace. Must be unique unless replace_all is true." },
      new_text: { type: "string", description: "Replacement text." },
      replace_all: {
        type: "boolean",
        description: "Replace EVERY occurrence instead of requiring a unique one (e.g. renaming a symbol).",
      },
    },
    required: ["path", "old_text", "new_text"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const rel = String(input.path ?? "");
    const oldText = String(input.old_text ?? "");
    const newText = String(input.new_text ?? "");
    const abs = safeResolve(ctx.workspaceRoot, rel);

    if (!(await exists(abs))) {
      return { output: `File '${rel}' does not exist. Use create_file.`, isError: true };
    }
    const before = await fs.readFile(abs, "utf8");
    const occurrences = before.split(oldText).length - 1;
    if (occurrences === 0) {
      return { output: `old_text was not found in '${rel}'. Read the file and try again.`, isError: true };
    }
    const replaceAll = Boolean(input.replace_all);
    if (occurrences > 1 && !replaceAll) {
      return {
        output: `old_text appears ${occurrences} times in '${rel}'. Provide a longer, unique snippet, or pass replace_all: true to change all ${occurrences}.`,
        isError: true,
      };
    }
    // split/join rather than a regex: old_text is literal user data and may well
    // contain characters a regex would interpret.
    const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);

    const preview = {
      title: replaceAll && occurrences > 1 ? `Edit ${rel} (${occurrences} occurrences)` : `Edit ${rel}`,
      diff: makeDiff(before, after, rel),
    };
    if (!(await ctx.requestApproval(preview))) {
      return { output: "User rejected the edit.", isError: true };
    }

    await fs.writeFile(abs, after, "utf8");
    ctx.log(`✏️ Edited ${rel}`);
    return { output: `Edited '${rel}' (${replaceAll ? occurrences : 1} replacement(s)).`, preview };
  }
}

/** List files in a directory (non-recursive by default). */
export class ListFilesTool implements Tool {
  readonly name = "list_files";
  readonly description = "List files and folders in a workspace directory.";
  readonly risk = "read" as const;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory. Defaults to root." },
    },
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const rel = String(input.path ?? ".");
    const abs = safeResolve(ctx.workspaceRoot, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter((e) => e.name !== "node_modules" && e.name !== ".git")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    ctx.log(`📁 Listed ${toRelative(ctx.workspaceRoot, abs) || "."}`);
    return { output: lines.join("\n") || "(empty directory)" };
  }
}

/** Below this size an overwrite can't destroy much, so it's never gated. */
const SMALL_FILE_BYTES = 400;
/** Keeping less than this fraction of a file's content is a wipe, not an edit. */
const WIPE_RATIO = 0.5;

/**
 * True when overwriting `before` with `after` throws away most of an existing
 * file. A model that summarises its work into the file it was asked to change —
 * or that fires a speculative "step 10" write — collapses a large file to a few
 * lines. That is never a legitimate targeted change, so it must be confirmed
 * even in auto mode. Growing or modestly rewriting a file is left alone.
 */
export function isDestructiveOverwrite(before: string, after: string): boolean {
  if (before.length <= SMALL_FILE_BYTES) return false;
  return after.length < before.length * WIPE_RATIO;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy or rename a file, byte for byte.
 *
 * Exists because "duplicate index.html as indxxx.html" was being answered by the
 * model REGENERATING the file from memory — which for a 495-line page produced a
 * 284-byte placeholder that shared nothing but the doctype. Duplication is a
 * deterministic operation; routing it through a language model is the bug. This
 * tool never involves the model in the contents at all.
 */
export class FileCopyTool implements Tool {
  readonly name = "copy_file";
  readonly description =
    "Copy a file to a new path, byte for byte (also used to rename/duplicate/back up). ALWAYS use this instead of reading a file and re-creating its contents — regenerating a file loses data.";
  readonly risk = "write" as const;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path of the file to copy." },
      dest: { type: "string", description: "Workspace-relative path to copy it to." },
      overwrite: {
        type: "boolean",
        description: "Replace dest if it already exists (default false).",
      },
    },
    required: ["path", "dest"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const rel = String(input.path ?? "");
    const destRel = String(input.dest ?? "");
    const overwrite = Boolean(input.overwrite);
    if (!rel || !destRel) {
      return { output: "Both 'path' and 'dest' are required.", isError: true };
    }
    const src = safeResolve(ctx.workspaceRoot, rel);
    const dest = safeResolve(ctx.workspaceRoot, destRel);
    if (src === dest) {
      return { output: `'${rel}' and '${destRel}' are the same file.`, isError: true };
    }
    if (!(await exists(src))) {
      return { output: `File '${rel}' does not exist.`, isError: true };
    }
    const destExists = await exists(dest);
    if (destExists && !overwrite) {
      return {
        output: `'${destRel}' already exists. Pass overwrite: true to replace it, or choose another name.`,
        isError: true,
      };
    }

    const bytes = await fs.readFile(src);
    const preview: ToolPreview = {
      title: destExists ? `Overwrite ${destRel} with a copy of ${rel}` : `Copy ${rel} → ${destRel}`,
      detail: `${bytes.length} bytes copied verbatim`,
      // Replacing an existing file with a copy throws away whatever was there.
      destructive: destExists,
    };
    if (!(await ctx.requestApproval(preview))) {
      return { output: "User rejected the copy.", isError: true };
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
    ctx.log(`📄 Copied ${rel} → ${destRel}`);
    return { output: `Copied '${rel}' to '${destRel}' (${bytes.length} bytes).`, preview };
  }
}

/**
 * Find files by NAME pattern — the capability whose absence made the agent
 * report "I searched but found nothing" for a file sitting in the project root.
 *
 * `search_code` searches file CONTENTS and `list_files` sees one directory, so
 * until now there was no way to answer "where is index.html?" across a tree.
 */
export class FindFilesTool implements Tool {
  readonly name = "find_files";
  readonly description =
    "Find files by name or glob pattern anywhere in the workspace (e.g. '**/*.html', 'index.html', 'src/**/*.ts'). Use this to LOCATE a file — search_code searches contents, this searches names.";
  readonly risk = "read" as const;
  readonly parameters = {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob: * matches within a segment, ** across directories, ? one character.",
      },
      limit: { type: "number", description: "Maximum results (default 200)." },
    },
    required: ["pattern"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const pattern = String(input.pattern ?? "").trim();
    if (!pattern) return { output: "A 'pattern' is required.", isError: true };
    const limit = Math.max(1, Math.min(Number(input.limit) || 200, 1000));

    const re = globToRegExp(pattern);
    const matches: string[] = [];
    await walk(ctx.workspaceRoot, ctx.workspaceRoot, matches, re, limit);

    if (!matches.length) {
      return {
        output: `No files match '${pattern}'. Try a looser pattern (e.g. '**/*.html' or '**/*name*').`,
      };
    }
    matches.sort();
    const shown = matches.slice(0, limit);
    return {
      output:
        `${matches.length} file(s) matching '${pattern}':\n` +
        shown.join("\n") +
        (matches.length > shown.length ? `\n… and ${matches.length - shown.length} more` : ""),
    };
  }
}

/** Directories never worth walking — they dwarf the real project. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "out", "dist", "build", ".next", ".venv", "venv",
  "__pycache__", ".cache", "coverage", ".idea", "target", "vendor", "Pods",
]);

async function walk(
  root: string,
  dir: string,
  out: string[],
  re: RegExp,
  limit: number
): Promise<void> {
  if (out.length >= limit * 2) return; // Enough to report a truthful total.
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await walk(root, full, out, re, limit);
    } else if (e.isFile()) {
      const rel = toRelative(root, full);
      if (re.test(rel) || re.test(e.name)) out.push(rel);
    }
  }
}

/**
 * Translate a glob to a regular expression. `**` crosses directory separators,
 * `*` and `?` do not — the standard meaning, and the one models assume.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` may also match zero directories, so `**/x` finds a root-level x.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/** Delete a file. Always asks — there is no undo. */
export class FileDeleteTool implements Tool {
  readonly name = "delete_file";
  readonly description = "Delete a file from the workspace. Always asks for confirmation.";
  readonly risk = "write" as const;
  readonly parameters = {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-relative path to delete." } },
    required: ["path"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const rel = String(input.path ?? "");
    const abs = safeResolve(ctx.workspaceRoot, rel);
    if (!(await exists(abs))) return { output: `'${rel}' does not exist.`, isError: true };
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      return { output: `'${rel}' is a directory; this tool only deletes files.`, isError: true };
    }
    const preview: ToolPreview = {
      title: `Delete ${rel}`,
      detail: `${stat.size} bytes — this cannot be undone`,
      // Deleting is always destructive, so auto-approve must never cover it.
      destructive: true,
    };
    if (!(await ctx.requestApproval(preview))) {
      return { output: "User rejected the deletion.", isError: true };
    }
    await fs.unlink(abs);
    ctx.log(`🗑️ Deleted ${rel}`);
    return { output: `Deleted '${rel}'.`, preview };
  }
}

/** Move or rename a file (copy, then remove the original). */
export class FileMoveTool implements Tool {
  readonly name = "move_file";
  readonly description =
    "Move or rename a file. Use copy_file instead if the original must stay.";
  readonly risk = "write" as const;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to move." },
      dest: { type: "string", description: "New workspace-relative path." },
      overwrite: { type: "boolean", description: "Replace dest if it exists (default false)." },
    },
    required: ["path", "dest"],
  };

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const rel = String(input.path ?? "");
    const destRel = String(input.dest ?? "");
    if (!rel || !destRel) return { output: "Both 'path' and 'dest' are required.", isError: true };
    const src = safeResolve(ctx.workspaceRoot, rel);
    const dest = safeResolve(ctx.workspaceRoot, destRel);
    if (src === dest) return { output: `'${rel}' and '${destRel}' are the same file.`, isError: true };
    if (!(await exists(src))) return { output: `'${rel}' does not exist.`, isError: true };
    const destExists = await exists(dest);
    if (destExists && !Boolean(input.overwrite)) {
      return { output: `'${destRel}' already exists. Pass overwrite: true to replace it.`, isError: true };
    }
    const preview: ToolPreview = {
      title: `Move ${rel} → ${destRel}`,
      detail: destExists ? `replaces the existing ${destRel}` : "renames the file",
      destructive: destExists,
    };
    if (!(await ctx.requestApproval(preview))) {
      return { output: "User rejected the move.", isError: true };
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    ctx.log(`📦 Moved ${rel} → ${destRel}`);
    return { output: `Moved '${rel}' to '${destRel}'.`, preview };
  }
}
