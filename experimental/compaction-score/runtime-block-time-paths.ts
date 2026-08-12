import type {
  RuntimeBlockScenario,
  RuntimeSummarySpan,
} from "./runtime-block-time-metrics";
import type { RuntimeSummaryTraceSpan } from "./runtime-block-time-instrumentation";

interface ExpectedPath {
  readonly candidateApplied: boolean;
  readonly overlaps: boolean;
  readonly statuses: readonly RuntimeSummarySpan["status"][];
}

const EXPECTED_PATHS: Readonly<
  Record<RuntimeBlockScenario, ExpectedPath>
> = {
  "late-overflow-miss": {
    candidateApplied: true,
    overlaps: false,
    statuses: ["completed", "completed"],
  },
  "overlap-nonblocking": {
    candidateApplied: false,
    overlaps: true,
    statuses: ["completed"],
  },
  "prepared-hit": {
    candidateApplied: true,
    overlaps: false,
    statuses: ["completed"],
  },
  "summary-failure-recovery": {
    candidateApplied: true,
    overlaps: false,
    statuses: ["error", "completed"],
  },
};

export function validateRuntimeBlockPath(
  spans: readonly RuntimeSummaryTraceSpan[],
  targetPrompt: unknown,
  providerStartedAtMs: number,
  scenario: RuntimeBlockScenario
): {
  readonly candidateApplied: boolean;
  readonly spans: readonly RuntimeSummarySpan[];
} {
  const causal = spans.filter(
    (span) => span.startedAtMs <= providerStartedAtMs
  );
  const expected = EXPECTED_PATHS[scenario];
  if (
    causal.length !== expected.statuses.length ||
    causal.some((span, index) => span.status !== expected.statuses[index])
  ) {
    throw new TypeError(`Invalid ${scenario} summary status path.`);
  }
  const settled = causal.map(
    (span): RuntimeSummarySpan => {
      if (span.status === "running") {
        throw new TypeError(`Invalid ${scenario} running summary path.`);
      }
      return Object.freeze({
        endedAtMs: span.endedAtMs,
        kind: span.kind,
        startedAtMs: span.startedAtMs,
        status: span.status,
      });
    }
  );
  const overlaps = settled.some(
    (span) =>
      span.startedAtMs <= providerStartedAtMs &&
      providerStartedAtMs < span.endedAtMs
  );
  if (overlaps !== expected.overlaps) {
    throw new TypeError(`Invalid ${scenario} provider overlap path.`);
  }
  const candidateApplied = JSON.stringify(targetPrompt).includes(
    "The conversation history before this point was compacted"
  );
  if (candidateApplied !== expected.candidateApplied) {
    throw new TypeError(`Invalid ${scenario} candidate application path.`);
  }
  return {
    candidateApplied,
    spans: Object.freeze(settled),
  };
}
