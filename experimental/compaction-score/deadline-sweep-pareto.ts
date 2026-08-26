import type {
  DeadlineHistoricalEvidence,
  DeadlineScenarioAggregate,
  DeadlineSweepReport,
} from "./deadline-sweep-types";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";

export function deadlineFullPareto(
  scenarios: DeadlineSweepReport["scenarios"],
  names: readonly RuntimeBlockScenario[]
): Readonly<Record<string, readonly number[]>> {
  return Object.fromEntries(
    names.map((scenario) => {
      const entries = Object.entries(scenarios[scenario] ?? {});
      return [
        scenario,
        entries
          .filter(([, candidate]) =>
            entries.every(
              ([, other]) => other === candidate || !dominates(other, candidate)
            )
          )
          .map(([deadline]) => Number(deadline)),
      ];
    })
  );
}

export function deadlineHistoricalPareto(
  scenarios: DeadlineSweepReport["scenarios"],
  historical: DeadlineHistoricalEvidence | null,
  names: readonly RuntimeBlockScenario[]
): Readonly<Record<string, readonly string[]>> {
  if (historical === null) {
    return {};
  }
  return Object.fromEntries(
    names.map((scenario) => {
      const old = historical.scenarios[scenario];
      if (old === undefined) {
        return [scenario, []];
      }
      const points = [
        ...Object.entries(scenarios[scenario] ?? {})
          .filter(([, value]) => value.completed > 0)
          .map(([label, value]) => ({
            candidate: value.candidateApplied.rate,
            label: `${label}ms`,
            latency: value.decisionLatencyMs.mean,
            provider: value.providerStarted.rate,
          })),
        {
          candidate: old.candidateAppliedRate,
          label: "historical-uncapped",
          latency: old.decisionMeanMs,
          provider: old.providerStartRate,
        },
      ];
      return [
        scenario,
        points.filter(isPareto(points)).map((point) => point.label),
      ];
    })
  );
}

function dominates(
  left: DeadlineScenarioAggregate,
  right: DeadlineScenarioAggregate
): boolean {
  if (right.completed === 0) {
    return left.completed > 0;
  }
  if (left.completed === 0) {
    return false;
  }
  const leftTyped = left.typedTimeoutIntegrity?.rate ?? 1;
  const rightTyped = right.typedTimeoutIntegrity?.rate ?? 1;
  const noWorse =
    left.decisionLatencyMs.mean <= right.decisionLatencyMs.mean &&
    left.timeout.rate <= right.timeout.rate &&
    left.providerStarted.rate >= right.providerStarted.rate &&
    left.candidateApplied.rate >= right.candidateApplied.rate &&
    left.pathValid.rate >= right.pathValid.rate &&
    leftTyped >= rightTyped &&
    left.reliability.rate >= right.reliability.rate &&
    left.summaryCallsMean <= right.summaryCallsMean;
  const better =
    left.decisionLatencyMs.mean < right.decisionLatencyMs.mean ||
    left.timeout.rate < right.timeout.rate ||
    left.providerStarted.rate > right.providerStarted.rate ||
    left.candidateApplied.rate > right.candidateApplied.rate ||
    left.pathValid.rate > right.pathValid.rate ||
    leftTyped > rightTyped ||
    left.reliability.rate > right.reliability.rate ||
    left.summaryCallsMean < right.summaryCallsMean;
  return noWorse && better;
}

interface HistoricalPoint {
  readonly candidate: number;
  readonly label: string;
  readonly latency: number;
  readonly provider: number;
}

function isPareto(
  points: readonly HistoricalPoint[]
): (point: HistoricalPoint) => boolean {
  return (point) =>
    !points.some(
      (other) =>
        other !== point &&
        other.latency <= point.latency &&
        other.provider >= point.provider &&
        other.candidate >= point.candidate &&
        (other.latency < point.latency ||
          other.provider > point.provider ||
          other.candidate > point.candidate)
    );
}
