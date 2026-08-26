import type { LanguageModel } from "ai";

export type RuntimeBlockLanguageModel = Exclude<LanguageModel, string>;

export type RuntimeBlockScenario =
  | "candidate-fit-hard-block"
  | "candidate-fit-late-hit"
  | "candidate-too-broad-fallback"
  | "overlap-nonblocking"
  | "prepared-hit"
  | "repeated-failure-overflow-recovery"
  | "summary-failure-retry-hit";

export interface RuntimeSummarySpan {
  readonly endedAtMs: number;
  readonly kind: "summary";
  readonly startedAtMs: number;
  readonly status: "completed" | "error";
}

export interface RuntimeBlockObservation {
  readonly candidateApplied: boolean;
  readonly controlFirstVisibleAtMs: number;
  readonly controlProviderStartedAtMs: number;
  readonly controlSentAtMs: number;
  readonly controlStepStartedAtMs: number;
  readonly controlTurnEndedAtMs?: number;
  readonly controlTurnStartedAtMs?: number;
  readonly pairOrder?: "control-treatment" | "treatment-control";
  readonly pathValid?: true;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summarySpans: readonly RuntimeSummarySpan[];
  readonly targetFirstVisibleAtMs: number;
  readonly targetProviderStartedAtMs: number;
  readonly targetSentAtMs: number;
  readonly targetStepStartedAtMs: number;
  readonly targetTurnEndedAtMs?: number;
  readonly targetTurnStartedAtMs?: number;
}

export interface RuntimeBlockTrial {
  readonly actualTurnDeltaMs?: number;
  readonly avoidedBlockMs: number;
  readonly blockAvoidanceRatio: number;
  readonly candidateApplied: boolean;
  readonly completionDeltaMs?: number;
  readonly controlCompletionMs?: number;
  readonly controlPreparationMs: number;
  readonly controlProviderDispatchMs: number;
  readonly controlRequestMs?: number;
  readonly controlTimeToFirstVisibleMs?: number;
  readonly controlTtfvMs: number;
  readonly dispatchBlockMs?: number;
  readonly gateDeltaMs: number;
  readonly overlapAtProviderStart: boolean;
  readonly pairOrder?: "control-treatment" | "treatment-control";
  readonly pathValid?: true;
  readonly preStepDeltaMs: number;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summaryCalls: number;
  readonly summaryServiceMs: number;
  readonly targetCompletionMs?: number;
  readonly targetPreparationMs?: number;
  readonly targetRequestMs?: number;
  readonly targetTimeToFirstVisibleMs?: number;
  readonly treatmentPreparationMs: number;
  readonly treatmentProviderDispatchMs: number;
  readonly treatmentTtfvMs: number;
  readonly userBlockMs: number;
  readonly userDeltaMs: number;
  readonly zeroBlock: boolean;
}

export interface RuntimeBlockAggregate {
  readonly blockAvoidanceRatioMean: number;
  readonly candidateAppliedRate: number;
  readonly gateDeltaMeanMs: number;
  readonly overlapRate: number;
  readonly preStepDeltaMeanMs: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summaryCallsMean: number;
  readonly summaryServiceMeanMs: number;
  readonly trials: number;
  readonly userBlockMaxMs: number;
  readonly userBlockMeanMs: number;
  readonly userBlockP50Ms: number;
  readonly userBlockP95Ms: number;
  readonly userDeltaMeanMs: number;
  readonly zeroBlockRate: number;
}

export interface RuntimeBlockTrialOptions {
  readonly abortSignal?: AbortSignal;
  readonly compactionDeadlineMs?: number;
  readonly controlModel?: RuntimeBlockLanguageModel;
  readonly model: RuntimeBlockLanguageModel;
  readonly now?: () => number;
  readonly onTargetStepStart?: () => void;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summaryTimeOffsetMs?: () => number;
  readonly treatmentModel?: RuntimeBlockLanguageModel;
}

export interface RuntimeBlockProviderCall {
  readonly kind: "foreground" | "summary";
  readonly prompt: unknown;
  readonly startedAtMs: number;
  readonly startedSequence: number;
}

export interface RuntimeBlockModelTrace {
  readonly calls: readonly RuntimeBlockProviderCall[];
  readonly model: RuntimeBlockLanguageModel;
  waitForCall(
    kind: RuntimeBlockProviderCall["kind"],
    afterIndex: number
  ): Promise<RuntimeBlockProviderCall>;
}

export interface RuntimeSummaryTraceSpan {
  endedAtMs: number;
  endedSequence: number;
  readonly kind: "summary";
  readonly startedAtMs: number;
  readonly startedSequence: number;
  status: "completed" | "error" | "running";
}

export interface ObservedRuntimeCompactionOptions {
  readonly active: Set<Promise<void>>;
  readonly deadlineMs?: number;
  readonly nextSequence: () => number;
  readonly now: () => number;
  readonly onSummarySettled?: (span: RuntimeSummaryTraceSpan) => void;
  readonly spans: RuntimeSummaryTraceSpan[];
}
