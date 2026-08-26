import type { RuntimeSummaryTraceSpan } from "./runtime-block-time-instrumentation";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";

export async function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void
): Promise<T> {
  if (signal === undefined) {
    return await work;
  }
  signal.throwIfAborted();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const listener = () => {
    onAbort?.();
    rejectAbort?.(signal.reason);
  };
  signal.addEventListener("abort", listener, { once: true });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

export function runtimeBlockTargetUnits(
  scenario: RuntimeBlockScenario
): number {
  if (scenario === "overlap-nonblocking") {
    return 50;
  }
  if (scenario === "prepared-hit") {
    return 150;
  }
  return scenario === "candidate-too-broad-fallback" ? 350 : 200;
}

export function requiredRuntimeBlockSummaries(
  scenario: RuntimeBlockScenario
): number {
  if (scenario === "prepared-hit" || scenario === "candidate-fit-late-hit") {
    return 1;
  }
  if (scenario === "summary-failure-retry-hit") {
    return 2;
  }
  return scenario === "repeated-failure-overflow-recovery" ? 2 : 0;
}

export async function waitForRuntimeBlockSummaryCount(
  spans: readonly RuntimeSummaryTraceSpan[],
  waiters: Map<number, () => void>,
  count: number
): Promise<void> {
  if (spans.length >= count && spans[count - 1]?.status !== "running") {
    return;
  }
  await new Promise<void>((resolve) => {
    waiters.set(count, resolve);
  });
  waiters.delete(count);
}
