import { Tool, toSchema } from "./Tool";
import { ToolSchema } from "../providers/types";
import {
  FileReadTool,
  FileCreateTool,
  FileWriteTool,
  FileEditTool,
  ListFilesTool,
} from "./FileTools";
import { TerminalTool, GitTool, TestTool, LintTool } from "./CommandTools";
import { GrepTool, ErrorAnalyzerTool } from "./SearchTools";

/** Owns the set of tools available to the agent and their JSON schemas. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const t of tools) {
      this.tools.set(t.name, t);
    }
  }

  static default(): ToolRegistry {
    return new ToolRegistry([
      new FileReadTool(),
      new ListFilesTool(),
      new GrepTool(),
      new FileCreateTool(),
      new FileEditTool(),
      new FileWriteTool(),
      new TerminalTool(),
      new TestTool(),
      new LintTool(),
      new GitTool(),
      new ErrorAnalyzerTool(),
    ]);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map(toSchema);
  }

  /** Only read-only tools — used in plan mode so the agent cannot make changes. */
  readOnlySchemas(): ToolSchema[] {
    return this.list()
      .filter((t) => t.risk === "read")
      .map(toSchema);
  }
}
