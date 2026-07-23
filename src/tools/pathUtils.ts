import * as path from "path";

/**
 * Resolve a user/model supplied path against the workspace root and guarantee
 * it does not escape the workspace (defence against `../../etc/passwd`).
 */
export function safeResolve(workspaceRoot: string, relativePath: string): string {
  const normalized = path.normalize(relativePath);
  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(workspaceRoot, normalized);
  const root = path.resolve(workspaceRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path '${relativePath}' is outside the workspace and was blocked.`);
  }
  return resolved;
}

export function toRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath) || path.basename(absolutePath);
}
