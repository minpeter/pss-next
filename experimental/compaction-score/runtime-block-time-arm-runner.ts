import { type AgentTurn, createAgent } from "@minpeter/pss-runtime";
import {
  abortable,
  requiredRuntimeBlockSummaries,
  runtimeBlockTargetUnits,
  waitForRuntimeBlockSummaryCount,
} from "./runtime-block-time-control";
import {
  awaitRuntimeBlockSummaries,
  createObservedRuntimeCompaction,
  createRuntimeBlockModelTrace,
  type RuntimeBlockModelTrace,
  type RuntimeSummaryTraceSpan,
  runtimeBlockInput,
} from "./runtime-block-time-instrumentation";
import { validateRuntimeBlockPath } from "./runtime-block-time-paths";
import type {
  RuntimeBlockTrialOptions,
  RuntimeSummarySpan,
} from "./runtime-block-time-types";

export interface MeasuredRuntimeBlockTurn {
  readonly call: Awaited<ReturnType<RuntimeBlockModelTrace["waitForCall"]>>;
  readonly firstVisibleAtMs: number;
  readonly providerStartedAtMs: number;
  readonly sentAtMs: number;
  readonly stepStartedAtMs: number;
  readonly turnEndedAtMs: number;
  readonly turnStartedAtMs: number;
}

export async function runRuntimeBlockTreatment(
  options: RuntimeBlockTrialOptions,
  now: () => number
): Promise<{
  readonly candidateApplied: boolean;
  readonly summarySpans: readonly RuntimeSummarySpan[];
  readonly target: MeasuredRuntimeBlockTurn;
}> {
  let sequence = 0;
  const nextSequence = (): number => {
    sequence += 1;
    return sequence;
  };
  const trace = createRuntimeBlockModelTrace(
    options.treatmentModel ?? options.model,
    now,
    nextSequence
  );
  const summarySpans: RuntimeSummaryTraceSpan[] = [];
  const activeSummaries = new Set<Promise<void>>();
  const summaryWaiters = new Map<number, () => void>();
  const compaction = createObservedRuntimeCompaction({
    active: activeSummaries,
    ...(options.compactionDeadlineMs === undefined
      ? {}
      : { deadlineMs: options.compactionDeadlineMs }),
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
    return await abortable(
      (async () => {
        const firstSummaryCall = trace.waitForCall("summary", 0);
        await measureRuntimeBlockTurn(
          () => thread.send(runtimeBlockInput(700)),
          trace,
          now
        );
        await measureRuntimeBlockTurn(
          () => thread.send(runtimeBlockInput(50)),
          trace,
          now
        );
        await firstSummaryCall;
        const summariesBeforeTarget = requiredRuntimeBlockSummaries(
          options.scenario
        );
        if (summariesBeforeTarget > 0) {
          await waitForRuntimeBlockSummaryCount(
            summarySpans,
            summaryWaiters,
            summariesBeforeTarget
          );
        }
        const target = await measureRuntimeBlockTurn(
          () =>
            thread.send(
              runtimeBlockInput(runtimeBlockTargetUnits(options.scenario))
            ),
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
      })(),
      options.abortSignal,
      () => thread.interrupt()
    );
  } finally {
    await agent.dispose();
  }
}

export async function runRuntimeBlockControl(
  options: RuntimeBlockTrialOptions,
  now: () => number
): Promise<MeasuredRuntimeBlockTurn> {
  const trace = createRuntimeBlockModelTrace(
    options.controlModel ?? options.model,
    now
  );
  const agent = await createAgent({ model: trace.model });
  const thread = agent.thread(
    `runtime-block-control-${options.scenario}-${options.repetition}-${crypto.randomUUID()}`
  );
  try {
    return await abortable(
      (async () => {
        await measureRuntimeBlockTurn(
          () => thread.send(runtimeBlockInput(700)),
          trace,
          now
        );
        await measureRuntimeBlockTurn(
          () => thread.send(runtimeBlockInput(50)),
          trace,
          now
        );
        return await measureRuntimeBlockTurn(
          () =>
            thread.send(
              runtimeBlockInput(runtimeBlockTargetUnits(options.scenario))
            ),
          trace,
          now
        );
      })(),
      options.abortSignal,
      () => thread.interrupt()
    );
  } finally {
    await agent.dispose();
  }
}

async function measureRuntimeBlockTurn(
  send: () => Promise<AgentTurn>,
  trace: RuntimeBlockModelTrace,
  now: () => number,
  onStepStart?: () => void
): Promise<MeasuredRuntimeBlockTurn> {
  const afterIndex = trace.calls.length;
  const providerCall = trace.waitForCall("foreground", afterIndex);
  const sentAtMs = now();
  const turn = await send();
  let firstVisibleAtMs: number | undefined;
  let stepStartedAtMs: number | undefined;
  let turnEndedAtMs: number | undefined;
  let turnStartedAtMs: number | undefined;
  for await (const event of turn.events()) {
    if (event.type === "turn-error" || event.type === "turn-abort") {
      throw new TypeError(`runtime block-time ${event.type}`);
    }
    if (event.type === "turn-start" && turnStartedAtMs === undefined) {
      turnStartedAtMs = now();
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
    if (event.type === "turn-end" && turnEndedAtMs === undefined) {
      turnEndedAtMs = now();
    }
  }
  const call = await providerCall;
  if (
    firstVisibleAtMs === undefined ||
    stepStartedAtMs === undefined ||
    turnEndedAtMs === undefined ||
    turnStartedAtMs === undefined
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
    turnEndedAtMs,
    turnStartedAtMs,
  };
}
