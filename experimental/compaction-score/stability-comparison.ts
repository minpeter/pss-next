import type { TrialSummary } from "./report";
import type {
  RecallFacts as RecallFactsShape,
  ReportFactIssue as ReportFactIssueShape,
  ReportRole as ReportRoleShape,
  StabilityComparisonFacts as StabilityComparisonFactsShape,
  StabilityReportFacts as StabilityReportFactsShape,
  TrialSummaryInspection as TrialSummaryInspectionShape,
} from "./stability-comparison-types";
import { reportFacts } from "./stability-report-facts";
import { inspectTrialSummary as inspectSummary } from "./trial-summary-parser";

export type RecallFacts = RecallFactsShape;
export type ReportFactIssue = ReportFactIssueShape;
export type ReportRole = ReportRoleShape;
export type StabilityComparisonFacts = StabilityComparisonFactsShape;
export type StabilityReportFacts = StabilityReportFactsShape;
export type TrialSummaryInspection = TrialSummaryInspectionShape;

export function inspectTrialSummary(
  value: unknown,
  report: ReportRole
): TrialSummaryInspection {
  return inspectSummary(value, report);
}

export function compareTrialSummaries(
  baseline: TrialSummary,
  candidate: TrialSummary
): StabilityComparisonFacts {
  const baselineFacts = reportFacts(baseline);
  const candidateFacts = reportFacts(candidate);
  const baselineScenarioRatios = new Map(
    baselineFacts.compression?.byScenario.map(({ ratio, scenario }) => [
      scenario,
      ratio.mean,
    ]) ?? []
  );
  const baselineDisagreements = new Set(
    baselineFacts.retention?.disagreements.map(({ fingerprint }) => fingerprint)
  );

  return {
    baseline: baselineFacts,
    candidate: candidateFacts,
    compressionDelta: {
      aggregateMean:
        baselineFacts.compression && candidateFacts.compression
          ? decimalDelta(
              candidateFacts.compression.aggregate.mean,
              baselineFacts.compression.aggregate.mean
            )
          : null,
      byScenario:
        candidateFacts.compression?.byScenario.flatMap(
          ({ ratio, scenario }) => {
            const baselineMean = baselineScenarioRatios.get(scenario);
            return baselineMean === undefined
              ? []
              : [
                  {
                    baseline: baselineMean,
                    candidate: ratio.mean,
                    delta: decimalDelta(ratio.mean, baselineMean),
                    scenario,
                  },
                ];
          }
        ) ?? [],
    },
    disagreementDrift:
      candidateFacts.retention?.disagreements.filter(
        ({ fingerprint }) => !baselineDisagreements.has(fingerprint)
      ) ?? [],
  };
}

function decimalDelta(candidate: number, baseline: number): number {
  return Number((candidate - baseline).toFixed(12));
}
