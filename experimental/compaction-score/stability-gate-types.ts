import type { BenchmarkScenario } from "./fixture";
import type { InvalidTrialStatus } from "./report";
import type { ReportRole } from "./stability-comparison-types";

interface StabilityGatePayloads {
  readonly AGGREGATE_MEAN_RATIO_REGRESSION: {
    readonly baseline: number;
    readonly candidate: number;
    readonly delta: number;
    readonly maximumDelta: number;
  };
  readonly ATTEMPTS_MISSING: {
    readonly attempted: number;
    readonly report: ReportRole;
  };
  readonly COMPACTION_PROMPT_FAILURE: BlockingInvalidPayload;
  readonly DISAGREEMENT_DRIFT: {
    readonly arm: "compacted" | "full";
    readonly category: string;
    readonly count: number;
    readonly fingerprint: string;
    readonly scenario: BenchmarkScenario;
  };
  readonly HOP_RATIO_NOT_BELOW_ONE: {
    readonly actual: number;
    readonly hop: number;
    readonly requiredBelow: number;
  };
  readonly NON_COMPRESSING_SUMMARY: BlockingInvalidPayload;
  readonly POSITIVE_SAVINGS_REQUIRED: {
    readonly actual: number;
    readonly requiredAbove: number;
  };
  readonly PROTOCOL_FAILURE: BlockingInvalidPayload;
  readonly PROVIDER_EVALUATOR_INVALID_RATE_EXCEEDED: {
    readonly attempted: number;
    readonly count: number;
    readonly maximum: number;
    readonly rate: number;
    readonly statuses: Readonly<
      Record<
        | "evaluation-provider-failure"
        | "invalid-full-control"
        | "summary-provider-failure",
        number
      >
    >;
  };
  readonly RECALL_BELOW_REQUIRED: {
    readonly actual: number;
    readonly correct: number;
    readonly id?: string;
    readonly required: number;
    readonly scope: "aggregate" | "category" | "scenario";
    readonly total: number;
  };
  readonly REPORT_CATEGORY_MISSING: {
    readonly category: string;
    readonly report: ReportRole;
  };
  readonly REPORT_HOP_MISSING: {
    readonly hop: number;
    readonly report: ReportRole;
  };
  readonly REPORT_JSON_INVALID: {
    readonly path: string;
    readonly report: ReportRole;
  };
  readonly REPORT_METRIC_INVALID: {
    readonly actual: string;
    readonly expected: string;
    readonly path: string;
    readonly report: ReportRole;
  };
  readonly REPORT_METRIC_MISSING: {
    readonly path: string;
    readonly report: ReportRole;
  };
  readonly REPORT_READ_FAILED: {
    readonly path: string;
    readonly report: ReportRole;
  };
  readonly REPORT_SCENARIO_MISSING: {
    readonly metric: "compression" | "retention";
    readonly report: ReportRole;
    readonly scenario: BenchmarkScenario;
  };
  readonly REPORT_SCENARIO_UNKNOWN: {
    readonly path: string;
    readonly report: ReportRole;
    readonly scenario: string;
  };
  readonly SCENARIO_MEAN_RATIO_REGRESSION: {
    readonly baseline: number;
    readonly candidate: number;
    readonly delta: number;
    readonly maximumDelta: number;
    readonly scenario: BenchmarkScenario;
  };
}

interface BlockingInvalidPayload {
  readonly attempted: number;
  readonly count: number;
  readonly status: InvalidTrialStatus;
}

export type StabilityGateCode = keyof StabilityGatePayloads;

export type StabilityGateFailure = {
  readonly [Code in StabilityGateCode]: {
    readonly code: Code;
    readonly payload: StabilityGatePayloads[Code];
  };
}[StabilityGateCode];

export interface StabilityGateDecision {
  readonly failures: readonly StabilityGateFailure[];
  readonly passed: boolean;
}
