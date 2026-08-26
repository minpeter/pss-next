import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";

export interface RuntimeDeadlineSummarySpan {
  readonly endedAtMs: number | null;
  readonly kind: "summary";
  readonly startedAtMs: number;
  readonly status: "completed" | "error" | "running";
}

export interface RuntimeDeadlineTrial {
  readonly candidateApplied: boolean;
  readonly deadlineMs: number;
  readonly decisionLatencyMs: number;
  readonly errorCategory?: string;
  readonly errorCode?: string;
  readonly outcome: "provider-started" | "timeout" | "turn-error";
  readonly pathValid: true;
  readonly providerStarted: boolean;
  readonly providerStartedAtMs: number | null;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summaryCallsStarted: number;
  readonly summarySpans: readonly RuntimeDeadlineSummarySpan[];
}
