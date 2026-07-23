import * as fs from "fs/promises";
import * as path from "path";

const IGNORE = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  "build",
  ".next",
  ".vscode-test",
  "__pycache__",
  ".venv",
  "venv",
]);

const MANIFESTS = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Package.swift",
  "Gemfile",
];

export interface ProjectSummary {
  root: string;
  tree: string;
  manifests: string[];
  detectedLanguages: string[];
}

/**
 * Builds a compact, model-friendly snapshot of the project so the agent starts
 * every task already grounded in the repository's shape.
 */
export class ProjectContext {
  constructor(private readonly root: string) {}

  async summarize(maxEntries = 400): Promise<ProjectSummary> {
    const entries: string[] = [];
    await this.walk(this.root, "", entries, maxEntries, 0);
    const manifests: string[] = [];
    for (const name of MANIFESTS) {
      try {
        await fs.access(path.join(this.root, name));
        manifests.push(name);
      } catch {
        /* not present */
      }
    }
    return {
      root: this.root,
      tree: entries.join("\n"),
      manifests,
      detectedLanguages: this.detectLanguages(entries),
    };
  }

  private async walk(
    dir: string,
    prefix: string,
    out: string[],
    max: number,
    depth: number
  ): Promise<void> {
    if (out.length >= max || depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      if (IGNORE.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        await this.walk(path.join(dir, e.name), rel, out, max, depth + 1);
      } else {
        out.push(rel);
      }
    }
  }

  private detectLanguages(entries: string[]): string[] {
    const byExt: Record<string, string> = {
      ".ts": "TypeScript",
      ".tsx": "TypeScript/React",
      ".js": "JavaScript",
      ".jsx": "JavaScript/React",
      ".py": "Python",
      ".swift": "Swift",
      ".java": "Java",
      ".go": "Go",
      ".rs": "Rust",
      ".rb": "Ruby",
      ".c": "C",
      ".cpp": "C++",
    };
    const found = new Set<string>();
    for (const e of entries) {
      const ext = path.extname(e);
      if (byExt[ext]) found.add(byExt[ext]);
    }
    return [...found];
  }
}
