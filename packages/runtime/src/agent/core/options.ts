import type { LanguageModel, ToolSet } from "ai";
import type { RuntimeDiagnosticsSink } from "../../diagnostics";
import type { AgentHost } from "../../execution/host/types";
import type { ContextBudgetSource } from "../../llm/context-gate";
import type { ContextTokenOptions } from "../../llm/context-tokens";
import type { PrepareModelStep } from "../../llm/model-step-preparation";
import type { AgentToolChoice } from "../../llm/model-step-types";
import {
  assertNoUnsupportedToolApproval,
  snapshotToolsWithoutUnsupportedApproval,
} from "../../llm/tool-approval";
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
import { snapshotAgentContextGate } from "./options-context-gate-validation";
import { assertThreadStateMigrationList } from "./options-thread-migration-validation";

export interface AgentOptions {
  readonly alwaysActiveTools?: readonly string[];
  readonly attachmentStore?: HostAttachmentStore;
  readonly compaction?: AgentCompaction;
  readonly contextGate?: ContextBudgetSource;
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

const validatedAgentOptionSnapshots = new WeakSet<object>();

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
  readonly contextGate?: false | ContextBudgetSource;
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

  const tools: unknown = Reflect.get(options, "tools");
  const alwaysActiveTools: unknown = Reflect.get(options, "alwaysActiveTools");
  const toolOrder: unknown = Reflect.get(options, "toolOrder");
  const prepareModelStep: unknown = Reflect.get(options, "prepareModelStep");
  const compaction: unknown = Reflect.get(options, "compaction");
  const contextGate: unknown = Reflect.get(options, "contextGate");
  const instrumentations: unknown = Reflect.get(options, "instrumentations");
  const threadMigrations: unknown = Reflect.get(options, "threadMigrations");

  assertNoUnsupportedToolApproval(tools);
  assertToolNameList(alwaysActiveTools, "alwaysActiveTools");
  assertToolNameList(toolOrder, "toolOrder");
  if (
    prepareModelStep !== undefined &&
    typeof prepareModelStep !== "function"
  ) {
    throw new TypeError("Agent: options.prepareModelStep must be a function.");
  }
  if (compaction !== undefined) {
    snapshotAgentCompaction(compaction);
  }
  if (contextGate !== undefined) {
    snapshotAgentContextGate(contextGate);
  }
  normalizeAgentInstrumentations(instrumentations);
  assertThreadStateMigrationList(threadMigrations);
  normalizeThreadStateMigrations(threadMigrations);
}

export function snapshotAgentOptions(options: AgentOptions): AgentOptions {
  if (options === undefined) {
    throw new TypeError("Agent options are required.");
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError("Agent options must be a non-null object.");
  }
  const compaction: unknown = options.compaction;
  const contextGate: unknown = options.contextGate;
  const tools: unknown = options.tools;
  const snapshot: AgentOptions = {
    alwaysActiveTools: options.alwaysActiveTools,
    attachmentStore: options.attachmentStore,
    compaction:
      compaction === undefined
        ? undefined
        : snapshotAgentCompaction(compaction),
    contextGate:
      contextGate === undefined
        ? undefined
        : snapshotAgentContextGate(contextGate),
    contextTokens: options.contextTokens,
    hooks: options.hooks,
    host: options.host,
    instructions: options.instructions,
    instrumentations: options.instrumentations,
    model: options.model,
    namespace: options.namespace,
    notificationOverlays: options.notificationOverlays,
    prepareModelStep: options.prepareModelStep,
    threadMigrations: options.threadMigrations,
    toolChoice: options.toolChoice,
    toolOrder: options.toolOrder,
    tools: undefined,
  };
  const toolsSnapshot = snapshotToolsWithoutUnsupportedApproval(tools);
  assertAgentOptions(snapshot);
  Object.assign(snapshot, { tools: toolsSnapshot });
  validatedAgentOptionSnapshots.add(snapshot);
  return snapshot;
}

export function consumeAgentOptions(options: AgentOptions): AgentOptions {
  if (validatedAgentOptionSnapshots.delete(options)) {
    return options;
  }
  return snapshotAgentOptions(options);
}

function snapshotAgentCompaction(compaction: unknown): AgentCompaction {
  if (typeof compaction !== "function") {
    throw new TypeError("Agent: options.compaction must be a function.");
  }
  const bufferTokens: unknown = Reflect.get(compaction, "bufferTokens");
  const deadlineMs: unknown = Reflect.get(compaction, "deadlineMs");
  const maxInputTokens: unknown = Reflect.get(compaction, "maxInputTokens");
  const estimateTokens: unknown = Reflect.get(compaction, "estimateTokens");
  const onOverflow: unknown = Reflect.get(compaction, "onOverflow");
  if (deadlineMs !== undefined && typeof deadlineMs !== "function") {
    throw new TypeError(
      "Agent: options.compaction.deadlineMs must be a function."
    );
  }
  if (maxInputTokens !== undefined && typeof maxInputTokens !== "function") {
    throw new TypeError(
      "Agent: options.compaction.maxInputTokens must be a function."
    );
  }
  if (estimateTokens !== undefined && typeof estimateTokens !== "function") {
    throw new TypeError(
      "Agent: options.compaction.estimateTokens must be a function."
    );
  }
  if (
    onOverflow !== undefined &&
    onOverflow !== "compact" &&
    onOverflow !== "error"
  ) {
    throw new TypeError(
      'Agent: options.compaction.onOverflow must be "compact" or "error".'
    );
  }
  const snapshot: AgentCompaction = (context) => compaction(context);
  Object.assign(snapshot, {
    bufferTokens,
    deadlineMs,
    estimateTokens,
    maxInputTokens,
    onOverflow,
  });
  return snapshot;
}

function assertToolNameList(
  value: unknown,
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
