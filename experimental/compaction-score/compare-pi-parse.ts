import type {
  ArmResult,
  ComparePiHop,
  ComparePiReport,
  ComparisonRow,
} from "./compare-pi-types";
import type { FixtureQuestion } from "./fixture";
import { parseCompareAnswers } from "./quality-sweep-live-answers";
import {
  array,
  finite,
  nonemptyString,
  nonnegativeInteger,
  object,
  positiveInteger,
} from "./quality-sweep-parse";
import type { CompactionScore, ScoreCount } from "./scorer";

export function parseComparePiReport(value: unknown): ComparePiReport {
  const report = object(value, "compare-pi report");
  if (report.schemaVersion !== "compare-pi-v3") {
    throw new TypeError("Invalid compare-pi report schema version.");
  }
  const repetitions = positiveInteger(
    report.repetitions,
    "compare-pi report.repetitions"
  );
  const summaryMaxOutputTokens = positiveInteger(
    report.summaryMaxOutputTokens,
    "compare-pi report.summaryMaxOutputTokens"
  );
  const rows = parseComparisonRows(report.rows, summaryMaxOutputTokens);
  if (rows.some((row) => row.repetition > repetitions)) {
    throw new TypeError("Compare-pi row exceeds report repetitions.");
  }
  return {
    model: nonemptyString(report.model, "compare-pi report.model"),
    repetitions,
    rows,
    schemaVersion: "compare-pi-v3",
    summaryMaxOutputTokens,
  };
}

export function parseComparisonRows(
  value: unknown,
  sentOutputTokens?: number
): readonly ComparisonRow[] {
  const rows = array(value, "compare-pi rows").map(parseComparisonRow);
  const keys = rows.map((row) => `${row.scenario}:${row.repetition}`);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("Compare-pi rows contain duplicate identities.");
  }
  if (
    sentOutputTokens !== undefined &&
    rows.some((row) =>
      [row.pi, row.pss].some((arm) =>
        arm.hops?.some((hop) => hop.sentOutputTokens !== sentOutputTokens)
      )
    )
  ) {
    throw new TypeError(
      "Compare-pi hop output cap does not match report budget."
    );
  }
  return rows;
}

function parseComparisonRow(value: unknown, index: number): ComparisonRow {
  const path = `compare-pi rows[${index}]`;
  const row = object(value, path);
  return {
    pi: parseArm(row.pi, `${path}.pi`),
    pss: parseArm(row.pss, `${path}.pss`),
    repetition: positiveInteger(row.repetition, `${path}.repetition`),
    scenario: nonemptyString(row.scenario, `${path}.scenario`),
  };
}

function parseArm(value: unknown, path: string): ArmResult {
  const arm = object(value, path);
  const status = nonemptyString(arm.status, `${path}.status`);
  if (status !== "valid") {
    return { error: nonemptyString(arm.error, `${path}.error`), status };
  }
  const score = parseScore(arm.score, `${path}.score`);
  const answers = parseCompareAnswers(arm.answers);
  const hops = array(arm.hops, `${path}.hops`).map((hop, index) =>
    parseHop(hop, `${path}.hops[${index}]`)
  );
  if (answers === undefined || answers.full.length !== score.headline.total) {
    throw new TypeError(`${path}.answers must match the score total.`);
  }
  if (answers.compacted.length !== answers.full.length || hops.length === 0) {
    throw new TypeError(`${path} has incomplete valid-arm evidence.`);
  }
  const semanticCorrect =
    arm.semanticCorrect === undefined
      ? undefined
      : scoreCountValue(arm.semanticCorrect, score.headline.total, path);
  return {
    answers,
    hops,
    score,
    ...(semanticCorrect === undefined ? {} : { semanticCorrect }),
    status: "valid",
  };
}

function parseHop(value: unknown, path: string): ComparePiHop {
  const hop = object(value, path);
  const compactionMs =
    hop.compactionMs === undefined
      ? undefined
      : finite(hop.compactionMs, `${path}.compactionMs`);
  if (compactionMs !== undefined && compactionMs < 0) {
    throw new TypeError(`${path}.compactionMs must be nonnegative.`);
  }
  return {
    ...(compactionMs === undefined ? {} : { compactionMs }),
    prefixTokens: positiveInteger(hop.prefixTokens, `${path}.prefixTokens`),
    sentOutputTokens: positiveInteger(
      hop.sentOutputTokens,
      `${path}.sentOutputTokens`
    ),
    ...(hop.summarizerInputTokens === undefined
      ? {}
      : {
          summarizerInputTokens: positiveInteger(
            hop.summarizerInputTokens,
            `${path}.summarizerInputTokens`
          ),
        }),
    summaryTokens: positiveInteger(hop.summaryTokens, `${path}.summaryTokens`),
  };
}

function parseScore(value: unknown, path: string): CompactionScore {
  const score = object(value, path);
  const arms = object(score.arms, `${path}.arms`);
  const compacted = parseScoreArm(arms.compacted, `${path}.arms.compacted`);
  const full = parseScoreArm(arms.full, `${path}.arms.full`);
  const headline = parseCount(score.headline, `${path}.headline`);
  if (
    headline.correct !== compacted.overall.correct ||
    headline.total !== compacted.overall.total ||
    full.overall.correct !== full.overall.total ||
    full.overall.total !== headline.total ||
    sumCounts(compacted.perCategory) !== compacted.overall.total ||
    sumCounts(full.perCategory) !== full.overall.total
  ) {
    throw new TypeError(`${path} has impossible score accounting.`);
  }
  return {
    arms: { compacted, full },
    disagreements: array(score.disagreements, `${path}.disagreements`).map(
      (entry, index) => parseDisagreement(entry, `${path}[${index}]`)
    ),
    headline,
  };
}

function parseDisagreement(
  value: unknown,
  path: string
): CompactionScore["disagreements"][number] {
  const item = object(value, path);
  const arm = item.arm;
  if (arm !== "compacted" && arm !== "full") {
    throw new TypeError(`${path} has an invalid disagreement arm.`);
  }
  if (typeof item.actual !== "string") {
    throw new TypeError(`${path}.actual must be a string.`);
  }
  return {
    actual: item.actual,
    arm,
    category: parseCategory(item.category, `${path}.category`),
    expected: nonemptyString(item.expected, `${path}.expected`),
    question: nonemptyString(item.question, `${path}.question`),
  };
}

function parseScoreArm(value: unknown, path: string) {
  const arm = object(value, path);
  return {
    overall: parseCount(arm.overall, `${path}.overall`),
    perCategory: array(arm.perCategory, `${path}.perCategory`).map(
      (entry, index) => {
        const category = object(entry, `${path}.perCategory[${index}]`);
        return {
          category: parseCategory(category.category, `${path}.category`),
          ...parseCount(category, path),
        };
      }
    ),
  };
}

function parseCount(value: unknown, path: string): ScoreCount {
  const count = object(value, path);
  const total = positiveInteger(count.total, `${path}.total`);
  return { correct: scoreCountValue(count.correct, total, path), total };
}

function scoreCountValue(value: unknown, total: number, path: string): number {
  const correct = nonnegativeInteger(value, `${path}.correct`);
  if (correct > total) {
    throw new TypeError(`${path}.correct exceeds total.`);
  }
  return correct;
}

function sumCounts(values: readonly ScoreCount[]): number {
  return values.reduce((total, value) => total + value.total, 0);
}

function parseCategory(
  value: unknown,
  path: string
): FixtureQuestion["category"] {
  switch (value) {
    case "boundary-recall":
    case "constraint-retention":
    case "distractor-resolution":
    case "exact-recall":
    case "file-state":
    case "hallucination-resistance":
    case "negative-knowledge":
    case "task-continuation":
    case "temporal-resolution":
    case "tool-history":
      return value;
    default:
      throw new TypeError(`${path} has an invalid question category.`);
  }
}
