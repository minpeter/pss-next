import type { ToolSet } from "ai";
import type { AgenticToolEvent } from "../agentic";
import type { AgenticTraceSink } from "../agentic-trace";
import type { EditTask } from "../tasks";

export type EditMethodId = "pss-json" | "omp-dsl" | "omp-json" | "grok-json";

export interface MethodToolHooks {
  readonly events: AgenticToolEvent[];
  readonly requestAttempt: number;
  readonly run: number;
  readonly task: EditTask;
  readonly trace: AgenticTraceSink | undefined;
  /** Path whose post-edit content is snapshotted for recovery metrics. */
  readonly targetPath: string;
}

export interface EditMethod {
  readonly id: EditMethodId;
  readonly instructions: string;
  createTools(workspace: string, hooks: MethodToolHooks): ToolSet;
}
