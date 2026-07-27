import type { LanguageModel, ToolSet } from "ai";
import {
  type ModelToolCacheFingerprintMetadata,
  noopRuntimeDiagnostics,
  type RuntimeDiagnosticsSink,
} from "../diagnostics";
import { diagnosticToolRegistry } from "./diagnostic-tool-registry";
import {
  compareToolNames,
  dataPropertyInPrototypeChain,
  MISSING_DATA_PROPERTY,
} from "./tool-property-descriptors";
import {
  countDynamicDescriptions,
  toolSemanticFingerprint,
} from "./tool-semantic-metadata";

interface ToolCacheFingerprintInput {
  readonly activeToolRegistry: ToolSet;
  readonly activeTools: readonly string[];
  readonly alwaysActiveToolCount: number;
  readonly attemptId: string;
  readonly model: LanguageModel;
  readonly registryNames: readonly string[];
  readonly runtimeStepIndex: number;
  readonly selectionDurationMs: number;
}

export function prepareToolCacheFingerprintReport(
  diagnostics: RuntimeDiagnosticsSink | undefined,
  input: ToolCacheFingerprintInput
): (() => void) | undefined {
  if (!diagnostics || diagnostics === noopRuntimeDiagnostics) {
    return;
  }
  let snapshot: ToolCacheFingerprintInput;
  try {
    snapshot = {
      ...input,
      activeToolRegistry: diagnosticToolRegistry(input.activeToolRegistry),
    };
  } catch {
    return;
  }
  let started = false;
  return () => {
    if (started) {
      return;
    }
    started = true;
    queueMicrotask(() => {
      reportToolCacheFingerprint(diagnostics, snapshot).catch(() => undefined);
    });
  };
}

async function reportToolCacheFingerprint(
  diagnostics: RuntimeDiagnosticsSink | undefined,
  input: ToolCacheFingerprintInput
): Promise<void> {
  if (!diagnostics || diagnostics === noopRuntimeDiagnostics) {
    return;
  }
  try {
    const [
      activeToolsFingerprint,
      modelIdentity,
      orderedToolNamesFingerprint,
      semanticFingerprint,
      registryToolNamesFingerprint,
    ] = await Promise.all([
      toolNamesFingerprint([...input.activeTools].sort(compareToolNames)),
      fingerprintModelIdentity(input.model),
      toolNamesFingerprint(input.activeTools),
      toolSemanticFingerprint(input.activeTools, input.activeToolRegistry),
      toolNamesFingerprint([...input.registryNames].sort(compareToolNames)),
    ]);
    const metadata: ModelToolCacheFingerprintMetadata = {
      activeToolCount: input.activeTools.length,
      activeToolsFingerprint,
      alwaysActiveToolCount: input.alwaysActiveToolCount,
      attemptId: input.attemptId,
      dynamicDescriptionToolCount: countDynamicDescriptions(
        input.activeTools,
        input.activeToolRegistry
      ),
      modelIdentityFingerprint: modelIdentity.fingerprint,
      modelIdentityFingerprintUnavailable: modelIdentity.unavailable,
      orderedToolNamesFingerprint,
      orderedToolSemanticFingerprint: semanticFingerprint.fingerprint,
      registeredToolCount: input.registryNames.length,
      registryToolNamesFingerprint,
      runtimeStepIndex: input.runtimeStepIndex,
      selectionDurationMs: input.selectionDurationMs,
      semanticFingerprintUnavailableToolCount:
        semanticFingerprint.unavailableToolCount,
      toolLoadingStrategy: "eager-active-tools",
    };
    await diagnostics.report({
      code: "model.tool_cache_fingerprint",
      level: "info",
      metadata,
      phase: "model-step",
    });
  } catch {
    // Diagnostics must never make a model step fail.
  }
}

async function fingerprintModelIdentity(model: LanguageModel): Promise<{
  readonly fingerprint: string;
  readonly unavailable: boolean;
}> {
  if (typeof model === "string") {
    return {
      fingerprint: await jsonFingerprint(["gateway", model]),
      unavailable: false,
    };
  }
  const specificationVersion = dataPropertyInPrototypeChain(
    model,
    "specificationVersion"
  );
  const provider = dataPropertyInPrototypeChain(model, "provider");
  const modelId = dataPropertyInPrototypeChain(model, "modelId");
  const unavailable = !(
    (specificationVersion === "v2" ||
      specificationVersion === "v3" ||
      specificationVersion === "v4") &&
    typeof provider === "string" &&
    typeof modelId === "string"
  );
  return {
    fingerprint: await jsonFingerprint([
      "model",
      specificationVersion === MISSING_DATA_PROPERTY
        ? { status: "unavailable" }
        : specificationVersion,
      provider === MISSING_DATA_PROPERTY ? { status: "unavailable" } : provider,
      modelId === MISSING_DATA_PROPERTY ? { status: "unavailable" } : modelId,
    ]),
    unavailable,
  };
}

function toolNamesFingerprint(names: readonly string[]): Promise<string> {
  return jsonFingerprint(names);
}

async function jsonFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}
