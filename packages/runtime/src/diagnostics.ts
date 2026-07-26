export type RuntimeDiagnosticLevel = "error" | "info" | "warning";

export interface ModelToolCacheFingerprintMetadata {
  readonly activeToolCount: number;
  readonly activeToolsFingerprint: string;
  readonly alwaysActiveToolCount: number;
  readonly attemptId: string;
  readonly dynamicDescriptionToolCount: number;
  readonly modelIdentityFingerprint: string;
  readonly modelIdentityFingerprintUnavailable: boolean;
  readonly orderedToolNamesFingerprint: string;
  readonly orderedToolSemanticFingerprint: string;
  readonly registeredToolCount: number;
  readonly registryToolNamesFingerprint: string;
  readonly runtimeStepIndex: number;
  readonly selectionDurationMs: number;
  readonly semanticFingerprintUnavailableToolCount: number;
  readonly toolLoadingStrategy: "eager-active-tools";
}

export interface RuntimeDiagnostic {
  readonly cause?: unknown;
  readonly code: string;
  readonly level: RuntimeDiagnosticLevel;
  readonly metadata?: ModelToolCacheFingerprintMetadata;
  readonly phase: "model-step";
  readonly threadKey?: string;
}

export interface RuntimeDiagnosticsSink {
  report(diagnostic: RuntimeDiagnostic): Promise<void> | void;
}

export const noopRuntimeDiagnostics: RuntimeDiagnosticsSink = {
  report: () => undefined,
};
