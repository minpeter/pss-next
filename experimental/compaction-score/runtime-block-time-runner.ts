import { type AgentTurn, createAgent } from "@minpeter/pss-runtime";
import {
  awaitRuntimeBlockSummaries,
  createObservedRuntimeCompaction,
  createRuntimeBlockModelTrace,
  type RuntimeBlockLanguageModel,
  type RuntimeBlockModelTrace,
  type RuntimeSummaryTraceSpan,
  runtimeBlockInput,
} from "./runtime-block-time-instrumentation";
import type {
  RuntimeBlockObservation,
  RuntimeBlockScenario,
  RuntimeSummarySpan,
} from "./runtime-block-time-metrics";
import { validateRuntimeBlockPath } from "./runtime-block-time-paths";

export interface RuntimeBlockTrialOptions {
  readonly model: RuntimeBlockLanguageModel;
  readonly now?: () => number;
  readonly onTargetStepStart?: () => void;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly summaryTimeOffsetMs?: () => number;
}

export async function runRuntimeBlockTrial(
  options: RuntimeBlockTrialOptions
): Promise<RuntimeBlockObservation> {
  const now = options.now ?? performance.now.bind(performance);
  let treatment: Awaited<ReturnType<typeof runTreatment>>;
  let control: MeasuredTurn;
  if (options.repetition % 2 === 1) {
    treatment = await runTreatment(options, now);
    control = await runControl(options, now);
  } else {
    control = await runControl(options, now);
    treatment = await runTreatment(options, now);
  }
  return {
    candidateApplied: treatment.candidateApplied,
    controlFirstVisibleAtMs: control.firstVisibleAtMs,
    controlProviderStartedAtMs: control.providerStartedAtMs,
    controlSentAtMs: control.sentAtMs,
    controlStepStartedAtMs: control.stepStartedAtMs,
    repetition: options.repetition,
    scenario: options.scenario,
    summarySpans: treatment.summarySpans,
    targetFirstVisibleAtMs: treatment.target.firstVisibleAtMs,
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
  let sequence = 0;
  const nextSequence = (): number => {
    sequence += 1;
    return sequence;
  };
  const trace = createRuntimeBlockModelTrace(options.model, now, nextSequence);
  const summarySpans: RuntimeSummaryTraceSpan[] = [];
  const activeSummaries = new Set<Promise<void>>();
  const summaryWaiters = new Map<number, () => void>();
  const compaction = createObservedRuntimeCompaction({
    active: activeSummaries,
    nextSequence,
    now: () => now() + (options.summaryTimeOffsetMs?.() ?? 0),
    onSummarySettled: () => summaryWaiters.get(summarySpans.length)?.(),
    spans: summarySpans,
  });
  const agent = await createAgent({ compaction, model: trace.model });
  const thread = agent.thread(
    `runtime-block-treatment-${options.scenario}-${options.repetition}-${crypto.randomUUID()}`
  );

  try {
    await measureTurn(() => thread.send(runtimeBlockInput(700)), trace, now);
    const summaryAfter = trace.calls.length;
    await measureTurn(() => thread.send(runtimeBlockInput(50)), trace, now);
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
      () => thread.send(runtimeBlockInput(targetUnits(options.scenario))),
      trace,
      now,
      options.onTargetStepStart
    );
    await awaitRuntimeBlockSummaries(activeSummaries);
    const path = validateRuntimeBlockPath({
      providerStartedSequence: target.call.startedSequence,
      scenario: options.scenario,
      spans: summarySpans,
      targetPrompt: target.call.prompt,
    });
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
  let sequence = 0;
  const trace = createRuntimeBlockModelTrace(options.model, now, () => {
    sequence += 1;
    return sequence;
  });
  const agent = await createAgent({ model: trace.model });
  const thread = agent.thread(
    `runtime-block-control-${options.scenario}-${options.repetition}-${crypto.randomUUID()}`
  );
  try {
    await measureTurn(() => thread.send(runtimeBlockInput(700)), trace, now);
    await measureTurn(() => thread.send(runtimeBlockInput(50)), trace, now);
    return await measureTurn(
      () => thread.send(runtimeBlockInput(targetUnits(options.scenario))),
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
  return scenario === "candidate-fit-hard-block" ? 350 : 200;
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
  readonly call: Awaited<ReturnType<RuntimeBlockModelTrace["waitForCall"]>>;
  readonly firstVisibleAtMs: number;
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
  let firstVisibleAtMs: number | undefined;
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
    if (
      firstVisibleAtMs === undefined &&
      (event.type === "assistant-output" ||
        event.type === "assistant-output-delta") &&
      event.text.trim().length > 0
    ) {
      firstVisibleAtMs = now();
    }
    if (event.type === "turn-end") {
      turnEnded = true;
    }
  }
  const call = await providerCall;
  if (
    firstVisibleAtMs === undefined ||
    stepStartedAtMs === undefined ||
    !turnEnded
  ) {
    throw new TypeError(
      "Runtime block-time trial did not complete one successful turn."
    );
  }
  return {
    call,
    firstVisibleAtMs,
    providerStartedAtMs: call.startedAtMs,
    sentAtMs,
    stepStartedAtMs,
  };
}
