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

  /** Common names models guess for our tools, mapped to the real tool name. */
  private static readonly ALIASES: Record<string, string> = {
    run_command: "run_terminal",
    run_shell: "run_terminal",
    shell: "run_terminal",
    bash: "run_terminal",
    execute_command: "run_terminal",
    terminal: "run_terminal",
    str_replace: "edit_file",
    str_replace_editor: "edit_file",
    replace_in_file: "edit_file",
    apply_edit: "edit_file",
    edit: "edit_file",
    write: "write_file",
    create: "create_file",
    new_file: "create_file",
    read: "read_file",
    cat: "read_file",
    ls: "list_files",
    list_dir: "list_files",
    grep: "search_code",
    search: "search_code",
    find: "search_code",
    run_test: "run_tests",
    test: "run_tests",
    lint: "run_linter",
  };

  get(name: string): Tool | undefined {
    const direct = this.tools.get(name);
    if (direct) return direct;
    const alias = ToolRegistry.ALIASES[name];
    return alias ? this.tools.get(alias) : undefined;
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
