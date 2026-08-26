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

export interface AutoCompactionDiagnosticMetadata {
  readonly compactionId: string;
  readonly deadlineAt?: number;
  readonly durationMs: number;
  readonly outcome: "committed" | "failed" | "skipped" | "timed-out";
  readonly reason: "completed-turn" | "manual" | "overflow";
  readonly runnerAttempt: number;
  readonly summaryCalls: number;
}

export interface RuntimeDiagnostic {
  readonly cause?: unknown;
  readonly code: string;
  readonly compaction?: AutoCompactionDiagnosticMetadata;
  readonly level: RuntimeDiagnosticLevel;
  readonly metadata?: ModelToolCacheFingerprintMetadata;
  readonly phase: "auto-compaction" | "model-step";
  readonly threadKey?: string;
}

export interface RuntimeDiagnosticsSink {
  report(diagnostic: RuntimeDiagnostic): Promise<void> | void;
}

export const noopRuntimeDiagnostics: RuntimeDiagnosticsSink = {
  report: () => undefined,
};
