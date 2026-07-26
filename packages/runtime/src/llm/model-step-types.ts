import type { generateText, LanguageModel, ModelMessage, ToolSet } from "ai";
import type { RuntimeDiagnosticsSink } from "../diagnostics";
import type { HostAttachmentStore } from "../thread/input/attachments";
import type { ModelUsage, StreamAgentEvent } from "../thread/protocol/events";
import type { ThreadContextMessage } from "../thread/state/context";
import type { ModelContextGateOptions } from "./context-gate";
import type {
  PreparedModelToolChoice,
  PrepareModelStep,
} from "./model-step-preparation";
import type { RuntimeToolExecutionContext } from "./tool-execution-types";

export type AgentToolChoice = PreparedModelToolChoice;
export type ModelStepOutput = Awaited<
  ReturnType<typeof generateText>
>["responseMessages"];
export type ModelStepOutputPart = ModelStepOutput[number];

export interface ModelStepResult {
  readonly messages: ModelStepOutput;
  readonly usage: ModelUsage;
}

export interface ModelGenerationOptions {
  alwaysActiveTools?: readonly string[];
  attachmentStore?: HostAttachmentStore;
  contextGate?: false | ModelContextGateOptions;
  diagnostics?: RuntimeDiagnosticsSink;
  instructions?: string;
  model: LanguageModel;
  prepareModelStep?: PrepareModelStep;
  toolChoice?: AgentToolChoice;
  toolOrder?: readonly string[];
  tools?: ToolSet;
}

export interface ModelStepOptions extends ModelGenerationOptions {
  history: readonly ThreadContextMessage[];
  onStreamEvent?: (event: StreamAgentEvent) => void;
  runtimeStepIndex?: number;
  signal: AbortSignal;
  threadKey?: string;
  toolExecution?: RuntimeToolExecutionContext;
}

export interface ModelPrompt {
  readonly instructions?: string;
  readonly messages: readonly ModelMessage[];
}
