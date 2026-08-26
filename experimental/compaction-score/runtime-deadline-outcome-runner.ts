import { type AgentTurn, createAgent } from "@minpeter/pss-runtime";
import {
  createObservedRuntimeCompaction,
  createRuntimeBlockModelTrace,
  runtimeBlockInput,
} from "./runtime-block-time-instrumentation";
import type {
  RuntimeBlockLanguageModel,
  RuntimeBlockModelTrace,
  RuntimeBlockScenario,
  RuntimeSummaryTraceSpan,
} from "./runtime-block-time-types";
import {
  freezeDeadlineSummarySpans,
  validateDeadlinePath,
  waitForRuntimeSummaryStart,
  waitForSummaryCount,
} from "./runtime-deadline-outcome-path";
import type { RuntimeDeadlineTrial } from "./runtime-deadline-outcome-types";

const SETUP_TIMEOUT_MS = 120_000;

export interface RuntimeDeadlineTrialOptions {
  readonly abortSignal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly model: RuntimeBlockLanguageModel;
  readonly now?: () => number;
  readonly onTargetStepStart?: () => void;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
}

export async function runRuntimeDeadlineTrial(
  options: RuntimeDeadlineTrialOptions
): Promise<RuntimeDeadlineTrial> {
  const now = options.now ?? performance.now.bind(performance);
  const deadlineMs = options.deadlineMs ?? 5000;
  const trace = createRuntimeBlockModelTrace(options.model, now);
  const summarySpans: RuntimeSummaryTraceSpan[] = [];
  const activeSummaries = new Set<Promise<void>>();
  const summaryWaiters = new Map<number, () => void>();
  let summarySequence = 0;
  const compaction = createObservedRuntimeCompaction({
    active: activeSummaries,
    deadlineMs,
    nextSequence: () => {
      summarySequence += 1;
      return summarySequence;
    },
    now,
    onSummarySettled: () => summaryWaiters.get(summarySpans.length)?.(),
    spans: summarySpans,
  });
  const agent = await createAgent({ compaction, model: trace.model });
  const thread = agent.thread(
    `runtime-deadline-${options.scenario}-${options.repetition}-${crypto.randomUUID()}`
  );

  try {
    return await abortableDeadlineWork(
      executeRuntimeDeadlineTrial({
        deadlineMs,
        now,
        onTargetStepStart: options.onTargetStepStart,
        repetition: options.repetition,
        scenario: options.scenario,
        send: (units) => thread.send(runtimeBlockInput(units)),
        summarySpans,
        summaryWaiters,
        trace,
      }),
      options.abortSignal,
      () => thread.interrupt()
    );
  } finally {
    await agent.dispose();
  }
}

async function executeRuntimeDeadlineTrial({
  deadlineMs,
  now,
  onTargetStepStart,
  repetition,
  scenario,
  send,
  summarySpans,
  summaryWaiters,
  trace,
}: {
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly onTargetStepStart?: () => void;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly send: (units: number) => Promise<AgentTurn>;
  readonly summarySpans: RuntimeSummaryTraceSpan[];
  readonly summaryWaiters: Map<number, () => void>;
  readonly trace: RuntimeBlockModelTrace;
}): Promise<RuntimeDeadlineTrial> {
  const firstSummaryCall = trace.waitForCall("summary", 0);
  await completeTurn(() => send(700));
  await completeTurn(() => send(50));
  await waitForRuntimeSummaryStart(firstSummaryCall, SETUP_TIMEOUT_MS);
  const summariesBeforeTarget = requiredSummariesBeforeTarget(scenario);
  if (summariesBeforeTarget > 0) {
    await waitForSummaryCount(
      summarySpans,
      summaryWaiters,
      summariesBeforeTarget,
      SETUP_TIMEOUT_MS
    );
  }
  const afterIndex = trace.calls.length;
  const sentAtMs = now();
  const terminal = await observeTarget(
    () => send(targetUnits(scenario)),
    now,
    onTargetStepStart
  );
  const providerCall = trace.calls
    .slice(afterIndex)
    .find((call) => call.kind === "foreground");
  const resolvedAtMs = providerCall?.startedAtMs ?? terminal.endedAtMs;
  const outcome = deadlineOutcome(
    providerCall !== undefined,
    terminal.errorCategory
  );
  const candidateApplied =
    providerCall !== undefined &&
    JSON.stringify(providerCall.prompt).includes(
      "The conversation history before this point was compacted"
    );
  const settledSpans = freezeDeadlineSummarySpans(summarySpans);
  validateDeadlinePath({
    candidateApplied,
    providerStarted: providerCall !== undefined,
    providerStartedAtMs: providerCall?.startedAtMs ?? null,
    spans: settledSpans,
  });
  return {
    candidateApplied,
    deadlineMs,
    decisionLatencyMs: Math.max(0, resolvedAtMs - sentAtMs),
    ...(terminal.errorCategory === undefined
      ? {}
      : { errorCategory: terminal.errorCategory }),
    ...(terminal.errorCode === undefined
      ? {}
      : { errorCode: terminal.errorCode }),
    outcome,
    pathValid: true,
    providerStarted: providerCall !== undefined,
    providerStartedAtMs: providerCall?.startedAtMs ?? null,
    repetition,
    scenario,
    summaryCallsStarted: summarySpans.length,
    summarySpans: settledSpans,
  };
}

function deadlineOutcome(
  providerStarted: boolean,
  errorCategory: string | undefined
): RuntimeDeadlineTrial["outcome"] {
  if (providerStarted) {
    return "provider-started";
  }
  return errorCategory === "timeout" ? "timeout" : "turn-error";
}

export async function abortableDeadlineWork<T>(
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

async function completeTurn(send: () => Promise<AgentTurn>): Promise<void> {
  const turn = await send();
  for await (const event of turn.events()) {
    if (event.type === "turn-error") {
      throw new TypeError(`runtime deadline setup failed: ${event.message}`);
    }
  }
}

async function observeTarget(
  send: () => Promise<AgentTurn>,
  now: () => number,
  onStepStart?: () => void
): Promise<{
  readonly endedAtMs: number;
  readonly errorCategory?: string;
  readonly errorCode?: string;
}> {
  const turn = await send();
  let errorCategory: string | undefined;
  let errorCode: string | undefined;
  for await (const event of turn.events()) {
    if (event.type === "step-start") {
      onStepStart?.();
    }
    if (event.type === "turn-error") {
      errorCategory = event.error?.category;
      errorCode = event.error?.code;
    }
  }
  return {
    endedAtMs: now(),
    ...(errorCategory === undefined ? {} : { errorCategory }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function targetUnits(scenario: RuntimeBlockScenario): number {
  if (scenario === "overlap-nonblocking") {
    return 50;
  }
  if (scenario === "prepared-hit") {
    return 150;
  }
  return scenario === "candidate-too-broad-fallback" ? 350 : 200;
}

function requiredSummariesBeforeTarget(scenario: RuntimeBlockScenario): number {
  if (scenario === "prepared-hit" || scenario === "candidate-fit-late-hit") {
    return 1;
  }
  if (scenario === "summary-failure-retry-hit") {
    return 2;
  }
  return scenario === "repeated-failure-overflow-recovery" ? 2 : 0;
}
