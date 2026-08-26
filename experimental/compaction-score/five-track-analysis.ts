import type { DeadlineSweepReport } from "./deadline-sweep-types";
import type {
  FiveTrackInputEvidence,
  FiveTrackReport,
  QualityCurvePoint,
} from "./five-track-types";
import type { HumanCalibrationReport } from "./human-calibration-types";
import type { ProductionOverlapReport } from "./production-overlap-types";
import type { QualitySweepReport } from "./quality-sweep-types";
import type { TaskUtilityReport } from "./task-utility-types";

export function createFiveTrackReport({
  deadline,
  human,
  inputs,
  production,
  quality,
  task,
}: {
  readonly deadline: DeadlineSweepReport;
  readonly human: HumanCalibrationReport;
  readonly inputs: FiveTrackReport["inputs"];
  readonly production: ProductionOverlapReport;
  readonly quality: QualitySweepReport;
  readonly task: TaskUtilityReport;
}): FiveTrackReport {
  const curve = quality.cells
    .filter((cell) => cell.valid > 0 && cell.total > 0)
    .map(toCurvePoint);
  const createdAt = [
    deadline.createdAt,
    human.createdAt,
    production.createdAt,
    quality.createdAt,
    task.createdAt,
  ]
    .sort()
    .at(-1);
  if (createdAt === undefined) {
    throw new TypeError("Five-track inputs require creation timestamps.");
  }
  return {
    createdAt,
    curves: {
      rateDistortionLatency: { points: curve, status: "measured" },
      utility: { status: "measured", summary: task.summary },
    },
    fairness: {
      fullProduct: {
        deadlines: deadline.scenarios,
        productionOverlap: production.aggregates,
        status: "measured",
        taskUtility: task.summary,
      },
      matchedOutputBudget: { cells: quality.cells, status: "measured" },
      matchedQuality: {
        estimates: quality.matchedQuality,
        status: "inferred",
      },
    },
    humanCalibration: human,
    inputs,
    measurementStatus: {
      deadlineOutcomes: "measured",
      humanCalibration: "measured",
      matchedQuality: "inferred",
      paretoDominance: "inferred",
      productionBlocking: "measured",
      providerCost: "unmeasured",
      quality: "measured",
      taskUtility: "measured",
    },
    methodology: {
      aggregateScore: "forbidden",
      crossTrackJoin: "none",
      fairnessRegimes: [
        "matched-output-budget",
        "matched-quality",
        "full-product",
      ],
      qualityOutputBudgetEnforcement:
        quality.methodology.outputBudgetEnforcement,
    },
    pareto: {
      deadline: {
        front: deadline.pareto,
        historicalFront: deadline.historicalPareto,
        status: "inferred",
      },
      quality: { front: qualityPareto(curve), status: "inferred" },
    },
    productionAttempts: production.attempts,
    schemaVersion: "five-track-report-v1",
  };
}

function toCurvePoint(
  cell: QualitySweepReport["cells"][number]
): QualityCurvePoint {
  return {
    arm: cell.arm,
    budget: cell.budget,
    compressionRatio: cell.compressionRatioMean,
    costUsd: null,
    latencyMeanMs: cell.latencyMeanMs,
    retention: cell.correct / cell.total,
    retentionWilson95: cell.wilson95,
    status: "measured",
  };
}

function qualityPareto(
  points: readonly QualityCurvePoint[]
): readonly string[] {
  return points
    .filter((candidate) =>
      points.every(
        (other) => other === candidate || !dominates(other, candidate)
      )
    )
    .map((point) => `${point.arm}:${point.budget}`);
}

function dominates(left: QualityCurvePoint, right: QualityCurvePoint): boolean {
  const leftCompression = left.compressionRatio ?? Number.POSITIVE_INFINITY;
  const rightCompression = right.compressionRatio ?? Number.POSITIVE_INFINITY;
  const leftLatency = left.latencyMeanMs ?? Number.POSITIVE_INFINITY;
  const rightLatency = right.latencyMeanMs ?? Number.POSITIVE_INFINITY;
  const noWorse =
    left.retention >= right.retention &&
    leftCompression <= rightCompression &&
    leftLatency <= rightLatency;
  const better =
    left.retention > right.retention ||
    leftCompression < rightCompression ||
    leftLatency < rightLatency;
  return noWorse && better;
}

export function fiveTrackEvidence(
  evidence: Omit<FiveTrackInputEvidence, "status">
): FiveTrackInputEvidence {
  return { ...evidence, status: "measured" };
}
