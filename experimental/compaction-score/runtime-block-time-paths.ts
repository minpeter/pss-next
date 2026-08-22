import type { RuntimeSummaryTraceSpan } from "./runtime-block-time-instrumentation";
import type {
  RuntimeBlockScenario,
  RuntimeSummarySpan,
} from "./runtime-block-time-metrics";

interface ExpectedPath {
  readonly candidateApplied: boolean;
  readonly overlaps: boolean;
  readonly statuses: readonly RuntimeSummarySpan["status"][];
}

const EXPECTED_PATHS: Readonly<Record<RuntimeBlockScenario, ExpectedPath>> = {
  "candidate-fit-late-hit": {
    candidateApplied: true,
    overlaps: false,
    statuses: ["completed"],
  },
  "candidate-fit-hard-block": {
    candidateApplied: true,
    overlaps: false,
    statuses: ["completed"],
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
  "repeated-failure-overflow-recovery": {
    candidateApplied: true,
    overlaps: false,
    statuses: ["error", "error", "completed"],
  },
  "summary-failure-retry-hit": {
    candidateApplied: true,
    overlaps: false,
    statuses: ["error", "completed"],
  },
};

interface RuntimeBlockPathInput {
  readonly providerStartedSequence: number;
  readonly scenario: RuntimeBlockScenario;
  readonly spans: readonly RuntimeSummaryTraceSpan[];
  readonly targetPrompt: unknown;
}

export function validateRuntimeBlockPath({
  providerStartedSequence,
  scenario,
  spans,
  targetPrompt,
}: RuntimeBlockPathInput): {
  readonly candidateApplied: boolean;
  readonly spans: readonly RuntimeSummarySpan[];
} {
  const causal = spans.filter(
    (span) => span.startedSequence < providerStartedSequence
  );
  const expected = EXPECTED_PATHS[scenario];
  if (
    causal.length !== expected.statuses.length ||
    causal.some((span, index) => span.status !== expected.statuses[index])
  ) {
    throw new TypeError(`Invalid ${scenario} summary status path.`);
  }
  const settled = causal.flatMap((span): readonly RuntimeSummarySpan[] =>
    span.status === "running"
      ? []
      : [
          Object.freeze({
            endedAtMs: span.endedAtMs,
            kind: span.kind,
            startedAtMs: span.startedAtMs,
            status: span.status,
          }),
        ]
  );
  const overlaps = causal.some(
    (span) =>
      span.startedSequence < providerStartedSequence &&
      providerStartedSequence < span.endedSequence
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
