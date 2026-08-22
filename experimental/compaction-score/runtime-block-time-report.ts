import {
  aggregateRuntimeBlockTrials,
  type RuntimeBlockAggregate,
  type RuntimeBlockObservation,
  type RuntimeBlockScenario,
  type RuntimeBlockTrial,
} from "./runtime-block-time-metrics";

export interface RuntimeBlockTimeReport {
  readonly aggregates: Readonly<
    Record<RuntimeBlockScenario, RuntimeBlockAggregate>
  >;
  readonly createdAt: string;
  readonly methodology: {
    readonly blockFormula: string;
    readonly clock: "logical deterministic clock" | "performance.now";
    readonly thresholdUnits: "synthetic benchmark units";
    readonly zeroBlockThresholdMs: number;
  };
  readonly mode: "deterministic" | "live";
  readonly model: string;
  readonly observations: readonly RuntimeBlockObservation[];
  readonly trials: readonly RuntimeBlockTrial[];
}

export function createRuntimeBlockTimeReport({
  createdAt = new Date().toISOString(),
  mode,
  model,
  observations,
  trials,
}: {
  readonly createdAt?: string;
  readonly mode: RuntimeBlockTimeReport["mode"];
  readonly model: string;
  readonly observations: readonly RuntimeBlockObservation[];
  readonly trials: readonly RuntimeBlockTrial[];
}): RuntimeBlockTimeReport {
  return {
    aggregates: {
      "candidate-fit-late-hit": aggregateRuntimeBlockTrials(
        "candidate-fit-late-hit",
        trials
      ),
      "candidate-fit-hard-block": aggregateRuntimeBlockTrials(
        "candidate-fit-hard-block",
        trials
      ),
      "overlap-nonblocking": aggregateRuntimeBlockTrials(
        "overlap-nonblocking",
        trials
      ),
      "prepared-hit": aggregateRuntimeBlockTrials("prepared-hit", trials),
      "repeated-failure-overflow-recovery": aggregateRuntimeBlockTrials(
        "repeated-failure-overflow-recovery",
        trials
      ),
      "summary-failure-retry-hit": aggregateRuntimeBlockTrials(
        "summary-failure-retry-hit",
        trials
      ),
    },
    createdAt,
    methodology: {
      blockFormula:
        "max(0, treatment send-to-first-visible-assistant-output - matched control send-to-first-visible-assistant-output)",
      clock:
        mode === "live" ? "performance.now" : "logical deterministic clock",
      thresholdUnits: "synthetic benchmark units",
      zeroBlockThresholdMs: 10,
    },
    mode,
    model,
    observations,
    trials,
  };
}

export function renderRuntimeBlockTimeMarkdown(
  report: RuntimeBlockTimeReport
): string {
  const aggregates = [
    report.aggregates["overlap-nonblocking"],
    report.aggregates["prepared-hit"],
    report.aggregates["candidate-fit-late-hit"],
    report.aggregates["candidate-fit-hard-block"],
    report.aggregates["summary-failure-retry-hit"],
    report.aggregates["repeated-failure-overflow-recovery"],
  ];
  return `${[
    "# Runtime speculative compaction block time",
    "",
    `Model: \`${report.model}\``,
    `Mode: \`${report.mode}\``,
    "",
    "| Scenario | Trials | Summary calls mean | Summary service mean | TTFV delta mean | User block mean | P50 | P95 | Max | Pre-step delta mean | Gate delta mean | Candidate applied | Zero-block rate | Block avoidance | Overlap rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...aggregates.map(renderAggregate),
    "",
    "## Trial details",
    "",
    "| Scenario | Run | Control TTFV | Treatment TTFV | TTFV delta | Control provider dispatch | Treatment provider dispatch | Pre-step delta | Gate delta | Summary calls | Summary service | User block | Avoided block | Block avoidance | Summary active at provider start |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.trials.map(renderTrial),
    "",
    "_TTFV is measured from send until the first non-empty `assistant-output-delta` or `assistant-output` event. User delta is treatment TTFV minus a fresh compaction-disabled control with the same three-turn inputs; user block clips that matched delta at zero. Provider dispatch remains reported separately and is not treated as visible output._",
    "",
    "_Benchmark payload size matches its synthetic threshold units. Live mode uses real provider latency and runtime concurrency; deterministic mode validates the measurement channel with a logical clock. Prepared hit completes its candidate before the target, which automatically promotes it before provider dispatch. A nonblocking path has user block at most 10 ms._",
  ].join("\n")}\n`;
}

function renderAggregate(aggregate: RuntimeBlockAggregate): string {
  return [
    `| ${scenarioLabel(aggregate.scenario)}`,
    aggregate.trials,
    aggregate.summaryCallsMean.toFixed(2),
    milliseconds(aggregate.summaryServiceMeanMs),
    signedMilliseconds(aggregate.userDeltaMeanMs),
    milliseconds(aggregate.userBlockMeanMs),
    milliseconds(aggregate.userBlockP50Ms),
    milliseconds(aggregate.userBlockP95Ms),
    milliseconds(aggregate.userBlockMaxMs),
    signedMilliseconds(aggregate.preStepDeltaMeanMs),
    signedMilliseconds(aggregate.gateDeltaMeanMs),
    percentage(aggregate.candidateAppliedRate),
    percentage(aggregate.zeroBlockRate),
    percentage(aggregate.blockAvoidanceRatioMean),
    `${percentage(aggregate.overlapRate)} |`,
  ].join(" | ");
}

function renderTrial(trial: RuntimeBlockTrial): string {
  return [
    `| ${scenarioLabel(trial.scenario)}`,
    trial.repetition,
    milliseconds(trial.controlTtfvMs),
    milliseconds(trial.treatmentTtfvMs),
    signedMilliseconds(trial.userDeltaMs),
    milliseconds(trial.controlProviderDispatchMs),
    milliseconds(trial.treatmentProviderDispatchMs),
    signedMilliseconds(trial.preStepDeltaMs),
    signedMilliseconds(trial.gateDeltaMs),
    trial.summaryCalls,
    milliseconds(trial.summaryServiceMs),
    milliseconds(trial.userBlockMs),
    milliseconds(trial.avoidedBlockMs),
    percentage(trial.blockAvoidanceRatio),
    `${trial.overlapAtProviderStart ? "yes" : "no"} |`,
  ].join(" | ");
}

function scenarioLabel(scenario: RuntimeBlockScenario): string {
  return scenario.replaceAll("-", " ");
}

function milliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function signedMilliseconds(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} ms`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
