import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";
import type { RuntimeDeadlineSummarySpan } from "./runtime-deadline-outcome-types";

export const DEADLINE_SWEEP_SCENARIOS = [
  "overlap-nonblocking",
  "prepared-hit",
  "candidate-fit-late-hit",
  "candidate-too-broad-fallback",
  "summary-failure-retry-hit",
  "repeated-failure-overflow-recovery",
] as const satisfies readonly RuntimeBlockScenario[];

export interface DeadlineArmAttempt {
  readonly message?: string;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly status: "completed" | "error" | "setup-error";
}

export interface DeadlineArmTrial {
  readonly candidateApplied: boolean;
  readonly deadlineMs: number;
  readonly decisionLatencyMs: number;
  readonly errorCategory?: string;
  readonly errorCode?: string;
  readonly outcome: "provider-started" | "timeout" | "turn-error";
  readonly pathValid?: boolean;
  readonly providerStarted: boolean;
  readonly providerStartedAtMs?: number | null;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summaryCallsStarted: number;
  readonly summarySpans: readonly RuntimeDeadlineSummarySpan[];
}

export interface DeadlineArm {
  readonly attempts: readonly DeadlineArmAttempt[];
  readonly createdAt: string;
  readonly deadlineMs: number;
  readonly mode: "deterministic" | "live";
  readonly model: string;
  readonly source: string;
  readonly trials: readonly DeadlineArmTrial[];
}

export interface DeadlineRate {
  readonly rate: number;
  readonly wilson95: readonly [number, number];
}

export interface DeadlineDistribution {
  readonly max: number;
  readonly mean: number;
  readonly meanCi95: readonly [number, number];
  readonly p95: number;
}

export interface DeadlineScenarioAggregate {
  readonly attemptErrors: number;
  readonly attempts: number;
  readonly candidateApplied: DeadlineRate;
  readonly completed: number;
  readonly decisionLatencyMs: DeadlineDistribution;
  readonly pathValid: DeadlineRate;
  readonly providerStarted: DeadlineRate;
  readonly reliability: DeadlineRate;
  readonly summaryCallsMean: number;
  readonly timeout: DeadlineRate;
  readonly typedTimeoutIntegrity: DeadlineRate | null;
}

export interface DeadlineArmAudit {
  readonly attemptErrors: number;
  readonly cells: number;
  readonly completed: number;
  readonly finiteLatencies: boolean;
  readonly pathPolicy: "legacy-unverified" | "required";
  readonly typedTimeouts: boolean;
  readonly uniqueCells: number;
}

export interface DeadlinePairedComparison {
  readonly candidateAppliedDelta: number;
  readonly fromDeadlineMs: number;
  readonly latencyDeltaMeanCi95: readonly [number, number];
  readonly latencyDeltaMeanMs: number;
  readonly pairs: number;
  readonly providerStartedDelta: number;
  readonly scenario: RuntimeBlockScenario;
  readonly toDeadlineMs: number;
}

export interface DeadlineHistoricalScenario {
  readonly candidateAppliedRate: number;
  readonly decisionMeanMs: number;
  readonly providerStartRate: number;
  readonly userBlockMeanMs: number;
}

export interface DeadlineHistoricalEvidence {
  readonly createdAt: string;
  readonly deadlineMs: number;
  readonly model: string;
  readonly scenarios: Readonly<
    Partial<Record<RuntimeBlockScenario, DeadlineHistoricalScenario>>
  >;
  readonly sha256: string;
  readonly source: string;
}

export interface DeadlineInputEvidence {
  readonly artifactSha256: string;
  readonly receiptPolicy: "exact-live-command" | "legacy-unverified";
  readonly receiptSha256: string | null;
  readonly source: string;
}

export interface DeadlineSweepReport {
  readonly arms: Readonly<Record<string, DeadlineArmAudit>>;
  readonly createdAt: string;
  readonly deadlinesMs: readonly number[];
  readonly historical: DeadlineHistoricalEvidence | null;
  readonly historicalPareto: Readonly<Record<string, readonly string[]>>;
  readonly inputEvidence: Readonly<
    Record<string, DeadlineInputEvidence>
  > | null;
  readonly methodology: {
    readonly bootstrapIterations: 10_000;
    readonly bootstrapSeed: 15_081;
    readonly pairedResampling: "whole-scenario-repetition-cells";
    readonly rateInterval: "wilson-95";
  };
  readonly mode: DeadlineArm["mode"];
  readonly model: string;
  readonly paired: readonly DeadlinePairedComparison[];
  readonly pareto: Readonly<Record<string, readonly number[]>>;
  readonly scenarios: Readonly<
    Record<string, Readonly<Record<string, DeadlineScenarioAggregate>>>
  >;
  readonly schemaVersion: "deadline-sweep-v1";
}
