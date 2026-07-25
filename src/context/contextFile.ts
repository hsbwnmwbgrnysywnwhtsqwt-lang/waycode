import * as fs from "fs/promises";
import * as path from "path";

/** Files WayCode treats as persistent project context (first match wins). */
const CONTEXT_FILES = ["WAYCODE.md", ".waycode.md", ".waycode/context.md"];

/** The canonical path used when creating a new context file. */
export function contextFilePath(root: string): string {
  return path.join(root, "WAYCODE.md");
}

/** A starter template for a new context file. */
export const CONTEXT_TEMPLATE = `# WayCode project context

Persistent instructions for the WayCode agent. Everything here is included in
every request, so keep it concise.

## About this project
- What it is, the stack, and anything non-obvious.

## Conventions
- Coding style, patterns, and things to always/never do.

## Useful commands
- build:
- test:
- lint:
`;

/** Read the project's context file, if present, formatted for the system prompt. */
export async function readContextFile(root: string): Promise<string> {
  for (const name of CONTEXT_FILES) {
    try {
      const content = await fs.readFile(path.join(root, name), "utf8");
      if (content.trim()) return `# Project context (from ${name})\n${content.trim()}`;
    } catch {
      /* not present — try the next */
    }
  }
  return "";
}
