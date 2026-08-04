import type { LanguageModel, ToolSet } from "ai";
import type { RuntimeDiagnosticsSink } from "../../diagnostics";
import type { AgentHost } from "../../execution/host/types";
import type { ModelContextGateOptions } from "../../llm/context-gate";
import type { ContextTokenOptions } from "../../llm/context-tokens";
import type { PrepareModelStep } from "../../llm/model-step-preparation";
import type { AgentToolChoice } from "../../llm/model-step-types";
import { assertNoUnsupportedToolApproval } from "../../llm/tool-approval";
import type { HostAttachmentStore } from "../../thread/input/attachments";
import type { AgentInput, UserInput } from "../../thread/input/input";
import type { AgentCompaction } from "../../thread/runtime/auto-compaction-types";
import {
  normalizeThreadStateMigrations,
  type ThreadStateMigration,
} from "../../thread/state/migrations";
import type { AgentHooks } from "./hooks";
import {
  type AgentInstrumentation,
  normalizeAgentInstrumentations,
} from "./instrumentation";

export const DEFAULT_AGENT_MAX_INPUT_TOKENS = 128_000;

export type AgentContextGateOptions = ModelContextGateOptions;

export interface AgentOptions {
  readonly alwaysActiveTools?: readonly string[];
  readonly attachmentStore?: HostAttachmentStore;
  readonly compaction?: AgentCompaction;
  readonly contextTokens?: ContextTokenOptions;
  readonly hooks?: AgentHooks;
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly instrumentations?: readonly AgentInstrumentation[];
  readonly model: LanguageModel;
  readonly namespace?: string;
  readonly notificationOverlays?: readonly (AgentInput | UserInput)[];
  readonly prepareModelStep?: PrepareModelStep;
  readonly threadMigrations?: readonly ThreadStateMigration[];
  readonly toolChoice?: AgentToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export type CreateAgentOptions = AgentOptions;

export type AgentModelOptions = Pick<
  AgentOptions,
  | "alwaysActiveTools"
  | "attachmentStore"
  | "instructions"
  | "contextTokens"
  | "model"
  | "prepareModelStep"
  | "toolChoice"
  | "toolOrder"
  | "tools"
> & {
  readonly contextGate?: false | AgentContextGateOptions;
  readonly contextTokenMeter?: import("../../llm/context-tokens").ContextTokenMeter;
  readonly diagnostics?: RuntimeDiagnosticsSink;
};

export function assertAgentOptions(
  options: unknown
): asserts options is AgentOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Agent options are required. Provide { model }.");
  }

  const hasModel = "model" in options && options.model != null;

  if (!hasModel) {
    throw new TypeError("Agent: missing options.model.");
  }

  if (typeof options.model !== "object" || options.model === null) {
    throw new TypeError("Agent: invalid options.model.");
  }

  const candidate = options as {
    readonly alwaysActiveTools?: AgentOptions["alwaysActiveTools"];
    readonly compaction?: AgentOptions["compaction"];
    readonly instrumentations?: AgentOptions["instrumentations"];
    readonly prepareModelStep?: AgentOptions["prepareModelStep"];
    readonly threadMigrations?: AgentOptions["threadMigrations"];
    readonly toolOrder?: AgentOptions["toolOrder"];
    readonly tools?: AgentOptions["tools"];
  };
  assertNoUnsupportedToolApproval(candidate.tools);
  assertToolNameList(candidate.alwaysActiveTools, "alwaysActiveTools");
  assertToolNameList(candidate.toolOrder, "toolOrder");
  if (
    candidate.prepareModelStep !== undefined &&
    typeof candidate.prepareModelStep !== "function"
  ) {
    throw new TypeError("Agent: options.prepareModelStep must be a function.");
  }
  if (
    candidate.compaction !== undefined &&
    typeof candidate.compaction !== "function"
  ) {
    throw new TypeError("Agent: options.compaction must be a function.");
  }
  normalizeAgentInstrumentations(candidate.instrumentations);
  normalizeThreadStateMigrations(candidate.threadMigrations);
}

function assertToolNameList(
  value: readonly string[] | undefined,
  field: "alwaysActiveTools" | "toolOrder"
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`Agent: options.${field} must be an array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !(
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0
    )
  ) {
    throw new TypeError(`Agent: options.${field} has an invalid length.`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor)) {
      throw new TypeError(
        `Agent: options.${field} must be a dense array of data-property tool names.`
      );
    }
    const name = descriptor.value;
    if (typeof name !== "string") {
      throw new TypeError(`Agent: options.${field} must contain only strings.`);
    }
    if (seen.has(name)) {
      throw new TypeError(
        `Agent: options.${field} contains duplicate tool ${JSON.stringify(name)}.`
      );
    }
    seen.add(name);
  }
}
