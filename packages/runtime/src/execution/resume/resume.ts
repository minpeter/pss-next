import {
  appendCheckpoint,
  resumeStateCheckpointReference,
  resumeStepFromCheckpoint,
  throwIfManualToolRecoveryRequired,
} from "./checkpoints";
import {
  appendModelOutput,
  createResumeToolExecution,
  emitModelOutputEvents,
  readModelOutput,
} from "./llm";
import type { ResumeRunOptions, ResumeRunResult } from "./types";

export type {
  ResumeRunBudget,
  ResumeRunOptions,
  ResumeRunResult,
  ResumeRunState,
  ResumeTurnStatus,
} from "./types";

export async function resumeRun(
  options: ResumeRunOptions
): Promise<ResumeRunResult> {
  const signal = options.signal ?? new AbortController().signal;
  if (options.budget.maxSteps <= 0) {
    return { status: "suspended", steps: 0 };
  }

  const resumedRun = await options.host.store.turns.get(options.runId);
  const leaseId = resumedRun?.lease?.leaseId ?? null;
  const attempt = resumedRun?.lease?.attempt ?? 1;
  const initialCheckpoint = await options.host.store.checkpoints.latest(
    options.runId
  );
  throwIfManualToolRecoveryRequired(initialCheckpoint);
  let nextStep = resumeStepFromCheckpoint(initialCheckpoint);
  let steps = 0;

  while (steps < options.budget.maxSteps) {
    if (signal.aborted) {
      return { status: "aborted", steps };
    }

    if (nextStep.phase === "new-step") {
      await options.host.store.events.append(options.runId, {
        type: "step-start",
      });
      const state = await options.loadState();
      await appendCheckpoint({
        host: options.host,
        leaseId,
        phase: "before-model",
        runId: options.runId,
        runtimeState: { step: nextStep.stepNumber },
        threadSnapshot: resumeStateCheckpointReference(state),
      });
    }

    const stateBeforeModel = await options.loadState();
    const toolExecution = createResumeToolExecution({
      attempt,
      host: options.host,
      leaseId,
      runId: options.runId,
      threadSnapshot: stateBeforeModel,
      stepNumber: nextStep.stepNumber,
    });
    const result = await readModelOutput({
      diagnostics: options.host.diagnostics,
      history: stateBeforeModel.history,
      model: options.model,
      runtimeStepIndex: nextStep.stepNumber - 1,
      signal,
      threadKey: resumedRun?.threadKey,
      toolExecution,
    });
    if (result === "aborted") {
      return { status: "aborted", steps };
    }
    await options.host.store.events.append(options.runId, result.usage);
    const output = result.messages;

    const stateAfterModel = appendModelOutput(stateBeforeModel, output);
    await options.saveState(stateAfterModel);
    await appendCheckpoint({
      host: options.host,
      leaseId,
      phase: "after-model",
      runId: options.runId,
      runtimeState: { step: nextStep.stepNumber },
      threadSnapshot: resumeStateCheckpointReference(stateAfterModel),
    });

    const shouldContinue = await emitModelOutputEvents({
      host: options.host,
      output,
      runId: options.runId,
    });
    await options.host.store.events.append(options.runId, {
      type: "step-end",
    });
    steps += 1;

    if (!shouldContinue) {
      return { status: "completed", steps };
    }

    if (steps >= options.budget.maxSteps) {
      await appendCheckpoint({
        host: options.host,
        leaseId,
        phase: "suspended",
        runId: options.runId,
        runtimeState: { step: nextStep.stepNumber },
        threadSnapshot: resumeStateCheckpointReference(stateAfterModel),
      });
      return { status: "suspended", steps };
    }

    nextStep = {
      phase: "new-step",
      stepNumber: nextStep.stepNumber + 1,
    };
  }

  return { status: "suspended", steps };
}
