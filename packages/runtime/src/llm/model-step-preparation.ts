import type { LanguageModel, ToolSet } from "ai";
import type { RuntimeDiagnosticsSink } from "../diagnostics";
import type { ThreadContextMessage } from "../thread/state/context";
import { ModelToolSelectionError } from "./model-step-error";
import type {
  PreparedModelToolChoice,
  PrepareModelStep,
} from "./model-step-preparation-types";
import {
  parsePrepareModelStepResult,
  snapshotToolChoice,
  validateToolChoice,
} from "./model-step-selection";
import { prepareToolCacheFingerprintReport } from "./tool-cache-fingerprint";
import {
  canonicalToolOrder,
  copyToolRegistry,
  readonlyToolRegistry,
  snapshotToolNames,
  validateToolNames,
} from "./tool-registry-snapshot";

export type {
  PreparedModelToolChoice,
  PrepareModelStep,
  PrepareModelStepInput,
  PrepareModelStepResult,
} from "./model-step-preparation-types";

export interface ResolveModelStepOptions {
  readonly alwaysActiveTools?: readonly string[];
  readonly attemptId: string;
  readonly diagnostics?: RuntimeDiagnosticsSink;
  readonly history: readonly ThreadContextMessage[];
  readonly model: LanguageModel;
  readonly prepareModelStep?: PrepareModelStep;
  readonly runtimeStepIndex: number;
  readonly signal: AbortSignal;
  readonly threadKey?: string;
  readonly toolChoice?: PreparedModelToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export interface ResolvedModelStepOptions {
  readonly activeTools?: readonly string[];
  readonly model: LanguageModel;
  readonly startToolCacheFingerprintReport?: () => void;
  readonly toolChoice?: PreparedModelToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export async function resolveModelStepOptions({
  alwaysActiveTools = [],
  attemptId,
  diagnostics,
  history,
  model,
  prepareModelStep,
  runtimeStepIndex,
  signal,
  threadKey,
  toolChoice,
  toolOrder = [],
  tools,
}: ResolveModelStepOptions): Promise<ResolvedModelStepOptions> {
  const registry = copyToolRegistry(tools);
  const registryNames = Object.keys(registry ?? {});
  const registrySet = new Set(registryNames);
  const alwaysActiveToolSnapshot = snapshotToolNames(
    alwaysActiveTools,
    "alwaysActiveTools",
    registryNames.length
  );
  const toolOrderSnapshot = snapshotToolNames(
    toolOrder,
    "toolOrder",
    registryNames.length
  );
  validateToolNames(alwaysActiveToolSnapshot, "alwaysActiveTools", registrySet);
  validateToolNames(toolOrderSnapshot, "toolOrder", registrySet);

  let preparedResult: unknown;
  let selectionDurationMs = 0;
  if (prepareModelStep) {
    if (threadKey === undefined) {
      throw new ModelToolSelectionError(
        "prepareModelStep requires a runtime threadKey."
      );
    }
    const selectionStarted = performance.now();
    preparedResult = await prepareModelStep({
      history: structuredClone([...history]),
      runtimeStepIndex,
      signal,
      threadKey,
      tools: readonlyToolRegistry(registry),
    });
    selectionDurationMs = Math.max(0, performance.now() - selectionStarted);
  }
  const prepared = parsePrepareModelStepResult(
    preparedResult,
    registryNames.length
  );

  const selectedTools = prepared?.activeTools;
  if (selectedTools !== undefined) {
    validateToolNames(selectedTools, "activeTools", registrySet);
  }

  const alwaysActiveSet = new Set(alwaysActiveToolSnapshot);
  for (const name of selectedTools ?? []) {
    if (alwaysActiveSet.has(name)) {
      throw new ModelToolSelectionError(
        `prepareModelStep activeTools contains always-active tool ${JSON.stringify(name)}.`
      );
    }
  }

  const canonicalRegistryOrder = canonicalToolOrder(
    registryNames,
    toolOrderSnapshot
  );
  const selectedSet = new Set(
    selectedTools ??
      canonicalRegistryOrder.filter((name) => !alwaysActiveSet.has(name))
  );
  const activeTools = [
    ...canonicalRegistryOrder.filter((name) => alwaysActiveSet.has(name)),
    ...canonicalRegistryOrder.filter((name) => selectedSet.has(name)),
  ];
  const executableTools = registry
    ? Object.fromEntries(activeTools.map((name) => [name, registry[name]]))
    : undefined;
  const effectiveToolChoice = snapshotToolChoice(
    prepared?.toolChoice === undefined ? toolChoice : prepared.toolChoice
  ) as PreparedModelToolChoice | undefined;
  validateToolChoice(effectiveToolChoice, registrySet, new Set(activeTools));
  const resolvedModel = prepared?.model ?? model;

  const startToolCacheFingerprintReport = prepareToolCacheFingerprintReport(
    diagnostics,
    {
      activeTools,
      activeToolRegistry: executableTools ?? {},
      alwaysActiveToolCount: alwaysActiveToolSnapshot.length,
      attemptId,
      model: resolvedModel,
      registryNames,
      runtimeStepIndex,
      selectionDurationMs,
    }
  );

  return {
    ...(executableTools === undefined ? {} : { tools: executableTools }),
    ...(registryNames.length === 0
      ? {}
      : { activeTools, toolOrder: activeTools }),
    model: resolvedModel,
    ...(effectiveToolChoice === undefined
      ? {}
      : { toolChoice: effectiveToolChoice }),
    ...(startToolCacheFingerprintReport === undefined
      ? {}
      : { startToolCacheFingerprintReport }),
  };
}
