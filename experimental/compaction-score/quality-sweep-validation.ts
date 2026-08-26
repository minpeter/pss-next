import { validateCampaignRepetitions } from "./campaign-limits";
import { validateQualityCells } from "./quality-sweep-cell-validation";
import { parseCompareAnswers } from "./quality-sweep-live-answers";
import {
  array,
  boolean,
  finite,
  isIntervalOrNull,
  nonemptyString,
  nonnegativeInteger,
  nullableFinite,
  object,
  positiveInteger,
} from "./quality-sweep-parse";
import type { QualitySweepObservation } from "./quality-sweep-types";

const BUDGETS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 13_107] as const;
const LIVE_SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
  "holdout-json",
  "holdout-cjk",
  "holdout-log",
] as const;

export interface QualitySweepValidation {
  readonly budgets: number;
  readonly invalidObservations: number;
  readonly matchedQualityComparisons: number;
  readonly model: string;
  readonly observations: number;
  readonly valid: true;
}

export function validateQualitySweepArtifact(
  raw: unknown
): QualitySweepValidation {
  const report = object(raw, "quality sweep");
  if (
    report.schemaVersion !== "quality-sweep-v2" ||
    (report.mode !== "deterministic" && report.mode !== "live") ||
    JSON.stringify(report.budgets) !== JSON.stringify(BUDGETS)
  ) {
    throw new TypeError("Invalid quality sweep identity.");
  }
  const repetitions = positiveInteger(report.repetitions, "repetitions");
  validateCampaignRepetitions(repetitions, "repetitions");
  if (report.mode === "live" && repetitions !== 3) {
    throw new TypeError("Live quality sweep requires exactly 3 repetitions.");
  }
  const model = nonemptyString(report.model, "model");
  const observations = array(report.observations, "observations").map(
    parseQualitySweepObservation
  );
  validateObservationGrid(observations, report.mode, repetitions);
  const cells = array(report.cells, "cells");
  validateQualityCells(cells, observations);
  const matched = array(report.matchedQuality, "matchedQuality");
  validateMatchedQuality(matched);
  validateMethodology(report.methodology);
  validateCalibrationItems(report.calibrationItems, report.mode);
  return {
    budgets: BUDGETS.length,
    invalidObservations: observations.filter(
      (observation) => !observation.valid
    ).length,
    matchedQualityComparisons: matched.length,
    model,
    observations: observations.length,
    valid: true,
  };
}

function validateCalibrationItems(raw: unknown, mode: unknown): void {
  const items = array(raw, "calibrationItems");
  if (mode === "deterministic" && items.length !== 6) {
    throw new TypeError(
      "Quality sweep calibration packet source is incomplete."
    );
  }
  if (
    mode === "live" &&
    (items.length !== 12 ||
      items.some((rawItem) => {
        const item = object(rawItem, "calibrationItem");
        return (
          typeof item.compactedAnswer !== "string" ||
          typeof item.fullAnswer !== "string" ||
          !Array.isArray(item.questions) ||
          item.questions.length !== 1
        );
      }))
  ) {
    throw new TypeError(
      "Live quality sweep calibration candidates are incomplete."
    );
  }
}

export function parseQualitySweepObservation(
  value: unknown,
  index: number
): QualitySweepObservation {
  const path = `observations[${index}]`;
  const item = object(value, path);
  const arm = item.arm;
  if (arm !== "pi" && arm !== "pss") {
    throw new TypeError(`${path}.arm is invalid.`);
  }
  const valid = boolean(item.valid, `${path}.valid`);
  const correct = nonnegativeInteger(item.correct, `${path}.correct`);
  const total = nonnegativeInteger(item.total, `${path}.total`);
  const controlCorrect = nonnegativeInteger(
    item.controlCorrect,
    `${path}.controlCorrect`
  );
  const controlTotal = nonnegativeInteger(
    item.controlTotal,
    `${path}.controlTotal`
  );
  const controlPassed = boolean(item.controlPassed, `${path}.controlPassed`);
  const compressionRatio = nullableFinite(
    item.compressionRatio,
    `${path}.compressionRatio`
  );
  const latencyMs = nullableFinite(item.latencyMs, `${path}.latencyMs`);
  const costUsd = nullableFinite(item.costUsd, `${path}.costUsd`);
  const sentOutputTokens = array(
    item.sentOutputTokens,
    `${path}.sentOutputTokens`
  ).map((sent, sentIndex) =>
    positiveInteger(sent, `${path}.sentOutputTokens[${sentIndex}]`)
  );
  if (
    valid &&
    (!controlPassed || controlTotal === 0 || controlCorrect !== controlTotal)
  ) {
    throw new TypeError(`${path} failed its full-context control.`);
  }
  const invalidReason =
    item.invalidReason === undefined
      ? undefined
      : nonemptyString(item.invalidReason, `${path}.invalidReason`);
  const evaluationAnswers = parseCompareAnswers(item.evaluationAnswers);
  if (item.evaluationAnswers !== undefined && evaluationAnswers === undefined) {
    throw new TypeError(`${path}.evaluationAnswers is invalid.`);
  }
  if (!valid && invalidReason === undefined) {
    throw new TypeError(`${path} silently omits its invalid reason.`);
  }
  const summaryTokens = nonnegativeInteger(
    item.summaryTokens,
    `${path}.summaryTokens`
  );
  if (
    valid &&
    summaryTokens >
      sentOutputTokens.reduce((totalTokens, tokens) => totalTokens + tokens, 0)
  ) {
    throw new TypeError(`${path} exceeds its enforced output budget.`);
  }
  return {
    arm,
    budget: positiveInteger(item.budget, `${path}.budget`),
    compressionRatio,
    controlCorrect,
    controlPassed,
    controlTotal,
    correct,
    costUsd,
    ...(evaluationAnswers === undefined ? {} : { evaluationAnswers }),
    fixtureSeed: nonemptyString(item.fixtureSeed, `${path}.fixtureSeed`),
    ...(invalidReason === undefined ? {} : { invalidReason }),
    latencyMs,
    repetition: positiveInteger(item.repetition, `${path}.repetition`),
    scenario: nonemptyString(item.scenario, `${path}.scenario`),
    sentOutputTokens,
    summarizerInputTokens: nonnegativeInteger(
      item.summarizerInputTokens,
      `${path}.summarizerInputTokens`
    ),
    summaryTokens,
    total,
    valid,
  };
}

function validateObservationGrid(
  observations: readonly QualitySweepObservation[],
  mode: unknown,
  repetitions: number
): void {
  const scenarios =
    mode === "live" ? LIVE_SCENARIOS : (["deterministic"] as const);
  const expected = BUDGETS.flatMap((budget) =>
    scenarios.flatMap((scenario) =>
      Array.from({ length: repetitions }, (_, repetition) =>
        (["pss", "pi"] as const).map(
          (arm) => `${arm}:${budget}:${scenario}:${repetition + 1}`
        )
      ).flat()
    )
  );
  const actual = observations.map(
    (item) => `${item.arm}:${item.budget}:${item.scenario}:${item.repetition}`
  );
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((key) => !actual.includes(key))
  ) {
    throw new TypeError("Quality sweep observation grid is incomplete.");
  }
}

function validateMatchedQuality(matched: readonly unknown[]): void {
  if (matched.length === 0) {
    throw new TypeError("Quality sweep has no matched-quality comparison.");
  }
  const withIntervals = matched.filter((raw) => {
    const item = object(raw, "matchedQuality");
    finite(item.quality, "matchedQuality.quality");
    finite(item.pssBudget, "matchedQuality.pssBudget");
    finite(item.piBudget, "matchedQuality.piBudget");
    finite(item.ratio, "matchedQuality.ratio");
    return (
      isIntervalOrNull(item.pssBudgetCi95) &&
      isIntervalOrNull(item.piBudgetCi95) &&
      isIntervalOrNull(item.ratioCi95)
    );
  });
  if (withIntervals.length === 0) {
    throw new TypeError("Quality sweep has no bootstrap-complete comparison.");
  }
}

function validateMethodology(value: unknown): void {
  const methodology = object(value, "methodology");
  if (
    methodology.bootstrapIterations !== 10_000 ||
    methodology.bootstrapSeed !== 0xb4_d6_e7 ||
    methodology.calibrationSampling !==
      "prefer-4096-fallback-nearest-captured-budget" ||
    methodology.interpolation !== "pav-isotonic-inverse-linear" ||
    methodology.invalidPolicy !== "excluded-with-explicit-count" ||
    methodology.outputBudgetEnforcement !==
      "local-four-characters-per-token-hard-cap"
  ) {
    throw new TypeError("Quality sweep methodology is invalid.");
  }
}
