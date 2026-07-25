import * as fs from "fs/promises";
import * as path from "path";
import { Tool, ToolContext, ToolRunResult } from "./Tool";
import { safeResolve, toRelative } from "./pathUtils";
import { makeDiff } from "./diff";

const MAX_READ_BYTES = 200_000;

/** Read a file's contents. */
export class FileReadTool implements Tool {
  readonly name = "read_file";
  readonly description = "Read the full contents of a text file in the workspace.";
  readonly risk = "read" as const;
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the file." },
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
    ctx.log(`📖 Read ${rel} (${content.split("\n").length} lines)`);
    return { output: content };
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
      old_text: { type: "string", description: "Exact text to replace (must be unique in the file)." },
      new_text: { type: "string", description: "Replacement text." },
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
    if (occurrences > 1) {
      return {
        output: `old_text appears ${occurrences} times in '${rel}'. Provide a longer, unique snippet.`,
        isError: true,
      };
    }
    const after = before.replace(oldText, newText);

    const preview = { title: `Edit ${rel}`, diff: makeDiff(before, after, rel) };
    if (!(await ctx.requestApproval(preview))) {
      return { output: "User rejected the edit.", isError: true };
    }

    await fs.writeFile(abs, after, "utf8");
    ctx.log(`✏️ Edited ${rel}`);
    return { output: `Edited '${rel}'.`, preview };
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
