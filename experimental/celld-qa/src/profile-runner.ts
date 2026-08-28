import {
  type ProcessMetricReport,
  type ProcessObservation,
  processMetricDelta,
} from "./process-observer";
import { requestAt } from "./profile-plans";
import {
  createProgressReporter,
  type ProgressReporter,
} from "./profile-progress";
import { type LatencySummary, summarizeLatencies } from "./profile-statistics";
import type {
  MonotonicClock,
  ProfileFetch,
  ProfilePlan,
  ProgressSnapshot,
} from "./profile-types";

interface RunnerOptions {
  readonly clock: MonotonicClock;
  readonly fetchRequest: ProfileFetch;
  readonly plan: ProfilePlan;
  readonly processSampler?: () => Promise<ProcessObservation>;
  readonly progressSink?: (jsonLine: string) => void;
  readonly signal?: AbortSignal;
  readonly waitUntil?: (deadlineMs: number) => Promise<void>;
}

interface Completion {
  readonly correct: boolean;
  readonly failed: boolean;
  readonly latencyMs: number;
  readonly token: number;
}

const REQUEST_TIMEOUT_MS = 30_000;

export interface ProfileReport {
  readonly admitted: number;
  readonly cleanup: {
    readonly aborted: number;
    readonly drained: boolean;
    readonly inFlight: number;
  };
  readonly completed: number;
  readonly correct: number;
  readonly elapsedMs: number;
  readonly failed: number;
  readonly incorrect: number;
  readonly latency: LatencySummary | null;
  readonly latencySamples: readonly number[];
  readonly processMetrics: ProcessMetricReport | null;
}

export async function runProfile({
  clock,
  fetchRequest,
  plan,
  processSampler,
  progressSink,
  signal: externalSignal,
  waitUntil = defaultWaitUntil(clock),
}: RunnerOptions): Promise<ProfileReport> {
  const startedAt = clock.now();
  const before = await processSampler?.();
  const controller = new AbortController();
  const runSignal =
    externalSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, externalSignal]);
  const active = new Map<number, Promise<Completion>>();
  const latencies: number[] = [];
  let admitted = 0;
  let completed = 0;
  let correct = 0;
  let failed = 0;
  let incorrect = 0;
  let nextToken = 0;
  let aborted = 0;
  let drained = true;
  const reporter: ProgressReporter | undefined =
    progressSink === undefined
      ? undefined
      : createProgressReporter({ clock, sink: progressSink });
  const snapshot = (): ProgressSnapshot => ({
    admitted,
    completed,
    failed,
    inFlight: active.size,
  });
  const admissionOpen = (): boolean =>
    !runSignal.aborted &&
    isAdmissionOpen(plan, admitted, clock.now() - startedAt);
  const hasWork = (): boolean => admissionOpen() || active.size > 0;

  while (hasWork()) {
    while (active.size < plan.concurrency && admissionOpen()) {
      const token = nextToken;
      nextToken += 1;
      const request = requestAt(plan, admitted);
      admitted += 1;
      const requestStartedAt = clock.now();
      const requestSignal = AbortSignal.any([
        runSignal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]);
      const pending = fetchRequest(request, requestSignal).then(
        (observation): Completion => ({
          correct: observation.correct,
          failed: false,
          latencyMs: clock.now() - requestStartedAt,
          token,
        }),
        (): Completion => ({
          correct: false,
          failed: true,
          latencyMs: clock.now() - requestStartedAt,
          token,
        })
      );
      active.set(token, pending);
    }
    if (active.size === 0) {
      break;
    }
    if (
      plan.kind === "soak" &&
      !isAdmissionOpen(plan, admitted, clock.now() - startedAt)
    ) {
      const deadline = startedAt + plan.admissionMs + plan.drainMs;
      const result = await Promise.race([
        Promise.all(active.values()).then(() => "drained" as const),
        waitUntil(deadline).then(() => "deadline" as const),
      ]);
      if (result === "deadline") {
        aborted = active.size;
        drained = false;
        controller.abort();
        break;
      }
    }
    const observation = await Promise.race(active.values());
    active.delete(observation.token);
    completed += 1;
    latencies.push(observation.latencyMs);
    failed += Number(observation.failed);
    correct += Number(!observation.failed && observation.correct);
    incorrect += Number(!(observation.failed || observation.correct));
    reporter?.record(snapshot());
  }

  const after = runSignal.aborted ? undefined : await processSampler?.();
  reporter?.finish(snapshot());
  return {
    admitted,
    cleanup: { aborted, drained, inFlight: active.size },
    completed,
    correct,
    elapsedMs: clock.now() - startedAt,
    failed,
    incorrect,
    latency: latencies.length === 0 ? null : summarizeLatencies(latencies),
    latencySamples: latencies,
    processMetrics:
      before === undefined || after === undefined
        ? null
        : processMetricDelta(before, after),
  };
}

function isAdmissionOpen(
  plan: ProfilePlan,
  admitted: number,
  elapsedMs: number
): boolean {
  switch (plan.kind) {
    case "hot":
    case "mixed":
    case "restart":
    case "wide":
      return admitted < plan.requestCount;
    case "soak":
      return elapsedMs < plan.admissionMs;
    default:
      return assertNever(plan);
  }
}

function defaultWaitUntil(
  clock: MonotonicClock
): (deadlineMs: number) => Promise<void> {
  return (deadlineMs) =>
    new Promise((resolve) => {
      const timeout = setTimeout(
        resolve,
        Math.max(0, deadlineMs - clock.now())
      );
      timeout.unref();
    });
}

function assertNever(value: never): never {
  throw new ProfilePlanError(String(value));
}

class ProfilePlanError extends Error {
  readonly name = "ProfilePlanError";
}
