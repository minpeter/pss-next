import type { DeadlineArmTrial } from "./deadline-sweep-types";
import type { RuntimeSummaryTraceSpan } from "./runtime-block-time-instrumentation";
import type {
  RuntimeDeadlineSummarySpan,
  RuntimeDeadlineTrial,
} from "./runtime-deadline-outcome-types";

export async function waitForRuntimeSummaryStart(
  summaryCall: Promise<unknown>,
  deadlineMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      summaryCall,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new TypeError(
                `runtime deadline setup summary did not start within ${deadlineMs}ms`
              )
            ),
          deadlineMs
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function waitForSummaryCount(
  spans: readonly RuntimeSummaryTraceSpan[],
  waiters: Map<number, () => void>,
  count: number,
  deadlineMs: number
): Promise<void> {
  if (spans.length >= count && spans[count - 1]?.status !== "running") {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        waiters.set(count, resolve);
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new TypeError(
                `runtime deadline setup summary ${count} did not settle within ${deadlineMs}ms`
              )
            ),
          deadlineMs
        );
      }),
    ]);
  } finally {
    waiters.delete(count);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function freezeDeadlineSummarySpans(
  spans: readonly RuntimeSummaryTraceSpan[]
): readonly RuntimeDeadlineSummarySpan[] {
  return Object.freeze(
    spans.map((span) =>
      Object.freeze({
        endedAtMs: span.status === "running" ? null : span.endedAtMs,
        kind: span.kind,
        startedAtMs: span.startedAtMs,
        status: span.status,
      })
    )
  );
}

export function validateDeadlinePath({
  candidateApplied,
  providerStarted,
  providerStartedAtMs,
  spans,
}: {
  readonly candidateApplied: boolean;
  readonly providerStarted: boolean;
  readonly providerStartedAtMs: number | null;
  readonly spans: readonly RuntimeDeadlineSummarySpan[];
}): true {
  const timestampsValid = spans.every(
    (span) =>
      Number.isFinite(span.startedAtMs) &&
      (span.endedAtMs === null ||
        (Number.isFinite(span.endedAtMs) && span.endedAtMs >= span.startedAtMs))
  );
  const candidateHasSummary = spans.some((span) => span.status === "completed");
  const candidateReadyBeforeProvider = spans.some(
    (span) =>
      span.status === "completed" &&
      span.endedAtMs !== null &&
      providerStartedAtMs !== null &&
      span.endedAtMs <= providerStartedAtMs
  );
  const ordered = spans.every(
    (span, index) =>
      index === 0 || span.startedAtMs >= (spans[index - 1]?.startedAtMs ?? 0)
  );
  if (
    !(timestampsValid && ordered) ||
    (candidateApplied &&
      !(providerStarted && candidateHasSummary && candidateReadyBeforeProvider))
  ) {
    throw new TypeError("Invalid runtime deadline causal path.");
  }
  return true;
}

export function parseDeadlineSummarySpans(
  value: unknown,
  path: string
): readonly RuntimeDeadlineSummarySpan[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new TypeError(`${path}[${index}] must be an object.`);
    }
    const kind = Reflect.get(raw, "kind");
    const status = Reflect.get(raw, "status");
    const startedAtMs = finiteSpanTime(Reflect.get(raw, "startedAtMs"), path);
    const rawEndedAtMs = Reflect.get(raw, "endedAtMs");
    const endedAtMs =
      rawEndedAtMs === null ? null : finiteSpanTime(rawEndedAtMs, path);
    if (
      kind !== "summary" ||
      (status !== "completed" && status !== "error" && status !== "running") ||
      (status === "running") !== (endedAtMs === null) ||
      (endedAtMs !== null && endedAtMs < startedAtMs)
    ) {
      throw new TypeError(`${path}[${index}] is invalid.`);
    }
    return {
      endedAtMs,
      kind,
      startedAtMs,
      status,
    };
  });
}

export function requireRuntimeDeadlineTrials(
  trials: readonly DeadlineArmTrial[]
): readonly RuntimeDeadlineTrial[] {
  return trials.map((trial) => {
    if (trial.pathValid !== true || trial.providerStartedAtMs === undefined) {
      throw new TypeError("Runtime deadline trial lacks causal path evidence.");
    }
    return {
      candidateApplied: trial.candidateApplied,
      deadlineMs: trial.deadlineMs,
      decisionLatencyMs: trial.decisionLatencyMs,
      ...(trial.errorCategory === undefined
        ? {}
        : { errorCategory: trial.errorCategory }),
      ...(trial.errorCode === undefined ? {} : { errorCode: trial.errorCode }),
      outcome: trial.outcome,
      pathValid: true,
      providerStarted: trial.providerStarted,
      providerStartedAtMs: trial.providerStartedAtMs,
      repetition: trial.repetition,
      scenario: trial.scenario,
      summaryCallsStarted: trial.summaryCallsStarted,
      summarySpans: trial.summarySpans,
    };
  });
}

function finiteSpanTime(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} timestamp must be finite.`);
  }
  return value;
}
