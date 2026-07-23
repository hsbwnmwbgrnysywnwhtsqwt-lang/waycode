import { ToolSchema } from "../providers/types";

/** How risky a tool is — used to decide when to ask the user for approval. */
export type ToolRisk = "read" | "write" | "execute";

/** A proposed change/action the UI can show before it happens. */
export interface ToolPreview {
  title: string;
  /** Optional unified-diff style preview for file edits. */
  diff?: string;
  /** Optional plain detail (e.g. the command to run). */
  detail?: string;
}

export interface ToolContext {
  /** Absolute path to the workspace root. */
  workspaceRoot: string;
  /** Ask the user to approve a risky action. Resolves true if approved. */
  requestApproval(preview: ToolPreview): Promise<boolean>;
  /** Emit progress/log text to the chat UI. */
  log(message: string): void;
}

export interface ToolRunResult {
  /** Text fed back to the model. */
  output: string;
  isError?: boolean;
  /** Optional structured preview shown in the UI. */
  preview?: ToolPreview;
}

/** Every capability the agent has is a Tool. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly parameters: Record<string, unknown>;

  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult>;
}

export function toSchema(tool: Tool): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
