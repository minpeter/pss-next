import type { TaskValidation } from "./task-utility-validator-types";

export type TaskUtilityArm = "compact" | "full";
export type TaskUtilityMode = "deterministic" | "live";

export interface TaskUtilityCheckpointPolicy {
  readonly attemptTimeoutMs: number;
  readonly fullControlAttempts: 3;
  readonly validator: "subprocess-v1";
}

export interface TaskUtilityCheckpointIdentity {
  readonly fixtures: readonly string[];
  readonly mode: TaskUtilityMode;
  readonly model: string;
  readonly policy: TaskUtilityCheckpointPolicy;
  readonly repetitions: number;
}

export interface TaskRateMetric {
  readonly denominator: number;
  readonly rate: number;
  readonly wilson95: readonly [number, number];
}

export interface TaskLatencyMetric {
  readonly max: number;
  readonly mean: number;
  readonly meanCi95: readonly [number, number];
  readonly p95: number;
}

export interface TaskArmExecution {
  readonly assistantOutput: string;
  readonly events: readonly unknown[];
  readonly summary: string | null;
}

export interface TaskArmResult {
  readonly arm: TaskUtilityArm;
  readonly assistantOutput: string;
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly events: readonly unknown[];
  readonly initialValidation: TaskValidation;
  readonly passed: boolean;
  readonly summary: string | null;
  readonly validation: TaskValidation;
  readonly workspace: string;
}

export interface TaskUtilityPair {
  readonly arms: readonly TaskArmResult[];
  readonly classification:
    | "context-loss-failure"
    | "downstream-execution-variance"
    | "invalid-full-control"
    | "retained-success";
  readonly compactPassed: boolean;
  readonly fixture: string;
  readonly fullPassed: boolean;
  readonly order: "compact-full" | "full-compact";
  readonly repetition: number;
}

export interface TaskUtilityReport {
  readonly attemptTimeoutMs: number;
  readonly createdAt: string;
  readonly fixtures: readonly string[];
  readonly methodology: {
    readonly compactSuccessCondition: "conditioned-on-full-success";
    readonly costPolicy: "null-without-explicit-rates";
    readonly interval: "wilson-95";
  };
  readonly mode: TaskUtilityMode;
  readonly model: string;
  readonly pairs: readonly TaskUtilityPair[];
  readonly repetitions: number;
  readonly schemaVersion: "task-utility-v1";
  readonly summary: {
    readonly compactConditionalSuccess: TaskRateMetric;
    readonly compactCostUsd: null;
    readonly compactLatencyMs: TaskLatencyMetric;
    readonly compactQuality: TaskRateMetric;
    readonly contextLossFailures: number;
    readonly fullControlSuccess: TaskRateMetric;
    readonly fullCostUsd: null;
    readonly fullLatencyMs: TaskLatencyMetric;
    readonly fullQuality: TaskRateMetric;
    readonly invalidFullControls: number;
    readonly retainedSuccesses: number;
  };
}
