import {
  type AgentTurn,
  createAgent,
} from "@minpeter/pss-runtime";
import type {
  RuntimeBlockObservation,
  RuntimeBlockScenario,
  RuntimeSummarySpan,
} from "./runtime-block-time-metrics";
import {
  awaitRuntimeBlockSummaries,
  createObservedRuntimeCompaction,
  createRuntimeBlockModelTrace,
  runtimeBlockInput,
  type RuntimeBlockLanguageModel,
  type RuntimeBlockModelTrace,
  type RuntimeSummaryTraceSpan,
} from "./runtime-block-time-instrumentation";
import { validateRuntimeBlockPath } from "./runtime-block-time-paths";

export {
  isCompactionProviderPrompt,
  type RuntimeBlockLanguageModel,
  runtimeBlockInput,
  runtimeBlockEstimator,
} from "./runtime-block-time-instrumentation";

export interface RuntimeBlockTrialOptions {
  readonly model: RuntimeBlockLanguageModel;
  readonly now?: () => number;
  readonly onTargetStepStart?: () => void;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
}

export async function runRuntimeBlockTrial(
  options: RuntimeBlockTrialOptions
): Promise<RuntimeBlockObservation> {
  const now = options.now ?? performance.now.bind(performance);
  const treatment = await runTreatment(options, now);
  const control = await runControl(options, now);
  return {
    candidateApplied: treatment.candidateApplied,
    controlProviderStartedAtMs: control.providerStartedAtMs,
    controlSentAtMs: control.sentAtMs,
    controlStepStartedAtMs: control.stepStartedAtMs,
    pathValid: true,
    repetition: options.repetition,
    scenario: options.scenario,
    summarySpans: treatment.summarySpans,
    targetProviderStartedAtMs: treatment.target.providerStartedAtMs,
    targetSentAtMs: treatment.target.sentAtMs,
    targetStepStartedAtMs: treatment.target.stepStartedAtMs,
  };
}

async function runTreatment(
  options: RuntimeBlockTrialOptions,
  now: () => number
): Promise<{
  readonly candidateApplied: boolean;
  readonly summarySpans: readonly RuntimeSummarySpan[];
  readonly target: MeasuredTurn;
}> {
  const trace = createRuntimeBlockModelTrace(options.model, now);
  const summarySpans: RuntimeSummaryTraceSpan[] = [];
  const activeSummaries = new Set<Promise<void>>();
  const summaryWaiters = new Map<number, () => void>();
  const compaction = createObservedRuntimeCompaction(
    summarySpans,
    activeSummaries,
    now,
    () => summaryWaiters.get(summarySpans.length)?.()
  );
  const agent = await createAgent({ compaction, model: trace.model });
  const thread = agent.thread(
    `runtime-block-treatment-${options.scenario}-${options.repetition}-${crypto.randomUUID()}`
  );

  try {
    await measureTurn(
      () => thread.send(runtimeBlockInput(700)),
      trace,
      now
    );
    const summaryAfter = trace.calls.length;
    await measureTurn(
      () => thread.send(runtimeBlockInput(50)),
      trace,
      now
    );
    await trace.waitForCall("summary", summaryAfter);
    const summariesBeforeTarget = requiredSummariesBeforeTarget(
      options.scenario
    );
    if (summariesBeforeTarget > 0) {
      await waitForSummaryCount(
        summarySpans,
        summaryWaiters,
        summariesBeforeTarget
      );
    }
    const target = await measureTurn(
      () =>
        thread.send(
          runtimeBlockInput(targetUnits(options.scenario))
        ),
      trace,
      now,
      options.onTargetStepStart
    );
    await awaitRuntimeBlockSummaries(activeSummaries);
    const path = validateRuntimeBlockPath(
      summarySpans,
      target.call.prompt,
      target.providerStartedAtMs,
      options.scenario
    );
    return {
      candidateApplied: path.candidateApplied,
      summarySpans: path.spans,
      target,
    };
  } finally {
    await agent.dispose();
  }
}

async function runControl(
  options: RuntimeBlockTrialOptions,
  now: () => number
): Promise<MeasuredTurn> {
  const trace = createRuntimeBlockModelTrace(options.model, now);
  const agent = await createAgent({ model: trace.model });
  const thread = agent.thread(
    `runtime-block-control-${options.scenario}-${options.repetition}-${crypto.randomUUID()}`
  );
  try {
    await measureTurn(
      () => thread.send(runtimeBlockInput(700)),
      trace,
      now
    );
    await measureTurn(
      () => thread.send(runtimeBlockInput(50)),
      trace,
      now
    );
    return await measureTurn(
      () =>
        thread.send(
          runtimeBlockInput(targetUnits(options.scenario))
        ),
      trace,
      now
    );
  } finally {
    await agent.dispose();
  }
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

function requiredSummariesBeforeTarget(
  scenario: RuntimeBlockScenario
): number {
  if (
    scenario === "prepared-hit" ||
    scenario === "candidate-fit-late-hit"
  ) {
    return 1;
  }
  if (scenario === "summary-failure-retry-hit") {
    return 2;
  }
  return scenario === "repeated-failure-overflow-recovery" ? 2 : 0;
}

async function waitForSummaryCount(
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

interface MeasuredTurn {
  readonly call: Awaited<
    ReturnType<RuntimeBlockModelTrace["waitForCall"]>
  >;
  readonly providerStartedAtMs: number;
  readonly sentAtMs: number;
  readonly stepStartedAtMs: number;
}

async function measureTurn(
  send: () => Promise<AgentTurn>,
  trace: RuntimeBlockModelTrace,
  now: () => number,
  onStepStart?: () => void
): Promise<MeasuredTurn> {
  const afterIndex = trace.calls.length;
  const providerCall = trace.waitForCall("foreground", afterIndex);
  const sentAtMs = now();
  const turn = await send();
  let stepStartedAtMs: number | undefined;
  let turnEnded = false;
  for await (const event of turn.events()) {
    if (event.type === "turn-error") {
      throw new TypeError("runtime block-time turn-error");
    }
    if (event.type === "step-start" && stepStartedAtMs === undefined) {
      stepStartedAtMs = now();
      onStepStart?.();
    }
    if (event.type === "turn-end") {
      turnEnded = true;
    }
  }
  const call = await providerCall;
  if (stepStartedAtMs === undefined || !turnEnded) {
    throw new TypeError(
      "Runtime block-time trial did not complete one successful turn."
    );
  }
  return {
    call,
    providerStartedAtMs: call.startedAtMs,
    sentAtMs,
    stepStartedAtMs,
  };
}
