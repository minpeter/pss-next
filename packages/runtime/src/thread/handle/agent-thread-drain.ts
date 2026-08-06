import { deferred } from "../../internal/deferred";
import { closeRuntimeInput } from "../input/runtime-input";
import { cancelQueuedDurableThreadInputs } from "../runtime/durable-input-cancellation";
import { unregisterLiveThreadInput } from "../runtime/live-input-ownership";
import type { AgentThreadContext } from "./agent-thread-context";
import { assertThreadMachineInvariants } from "./agent-thread-machines";
import { recoverThreadDurableInputClaims } from "./durable-queue-claims";
import { runThreadInputDrainLoop } from "./thread-drain";
import { withThreadDrainOwnership } from "./thread-drain-coordinator";

export async function drainAgentThreadInputQueue(
  context: AgentThreadContext
): Promise<void> {
  const { drain, terminal, turn } = context;
  const current = drain.state;
  if (current.tag === "draining") {
    // A loop is already running; ask it to restart once it finishes so it
    // observes inputs admitted after its current pass.
    drain.to({ ...current, restartRequested: true });
    return await current.promise;
  }

  const loopSettled = deferred();
  loopSettled.promise.catch(() => undefined);
  drain.to({
    tag: "draining",
    promise: loopSettled.promise,
    restartRequested: false,
  });

  const loop = withThreadDrainOwnership(
    context.execution.executionHost,
    context.threadKey,
    context,
    async ({ refreshRequired }) => {
      await recoverThreadDurableInputClaims({
        allowOwned: true,
        executionHost: context.execution.executionHost,
        state: context.durableInputRecovery,
        threadKey: context.threadKey,
      });
      if (refreshRequired) {
        await context.state.refresh();
      }
      return await runThreadInputDrainLoop({
        activate: ({ abort, run, runtimeInput, turnId }) => {
          turn.to({ tag: "active", abort, run, runtimeInput, turnId });
        },
        continueDraining: () => {
          if (terminal.state.tag !== "open") {
            return false;
          }
          const state = drain.state;
          return !(state.tag === "draining" && state.restartRequested);
        },
        deactivateRun: () => {
          const state = turn.state;
          if (state.tag === "active") {
            turn.to({
              tag: "finishing",
              abort: state.abort,
              run: state.run,
              turnId: state.turnId,
            });
          }
        },
        events: context.events,
        execution: context.execution,
        inputQueue: context.inputQueue,
        model: context.model,
        onBlocked: (released) => {
          released
            .then(() => restartReleasedThreadDrain(context))
            .catch(() => undefined);
        },
        release: () => {
          turn.to({ tag: "none" });
        },
        state: context.state,
        threadKey: context.threadKey,
      });
    }
  );
  loop.then(loopSettled.resolve, loopSettled.reject);

  try {
    await loop;
  } finally {
    const state = drain.state;
    const shouldRestart =
      state.tag === "draining" &&
      state.restartRequested &&
      terminal.state.tag === "open";
    drain.to({ tag: "idle" });
    // The loop has settled: every activated turn must have been released.
    assertThreadMachineInvariants(context);
    if (shouldRestart) {
      await drainAgentThreadInputQueue(context);
    }
  }
}

const RELEASED_DRAIN_RETRY_LIMIT = 3;

async function restartReleasedThreadDrain(
  context: AgentThreadContext
): Promise<void> {
  await retryReleasedThreadDrain(
    () => drainAgentThreadInputQueue(context),
    (failure) => settleInputsAfterRestartFailure(context, failure, true)
  );
}

/** @internal exported for retry/observability regression tests. */
export async function retryReleasedThreadDrain(
  drain: () => Promise<void>,
  onPermanentFailure: (failure: unknown) => Promise<void> | void,
  retryLimit = RELEASED_DRAIN_RETRY_LIMIT
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    try {
      await drain();
      return;
    } catch (error) {
      failure = error;
      await Promise.resolve();
    }
  }
  await onPermanentFailure(failure);
}

async function settleInputsAfterRestartFailure(
  context: AgentThreadContext,
  failure: unknown,
  retryOnCancellationFailure: boolean
): Promise<void> {
  const items = [...context.inputQueue];
  const message = `Thread drain restart failed after ${RELEASED_DRAIN_RETRY_LIMIT} attempts: ${errorMessage(failure)}`;
  await recoverOrCancelReleasedDrain({
    cancel: () =>
      cancelQueuedDurableThreadInputs({
        executionHost: context.execution.executionHost,
        items,
        threadKey: context.threadKey,
      }),
    drain: () => drainAgentThreadInputQueue(context),
    onCancelled: () => {
      const removed = removeQueuedInputsByIdentity(context.inputQueue, items);
      for (const item of removed) {
        if (item.durableMessageId) {
          unregisterLiveThreadInput(
            context.execution.executionHost,
            context.threadKey,
            item.durableMessageId,
            item.durableOwner
          );
        }
        closeRuntimeInput(item.runtimeInput, message);
        item.run.emit({ message, type: "turn-error" });
        item.run.close();
      }
    },
    retryOnCancellationFailure,
  });
}

/** @internal exported for queue-mutation regression tests. */
export function removeQueuedInputsByIdentity<T>(
  queue: T[],
  snapshot: readonly T[]
): T[] {
  const removed: T[] = [];
  for (const item of snapshot) {
    const index = queue.indexOf(item);
    if (index >= 0) {
      removed.push(...queue.splice(index, 1));
    }
  }
  return removed;
}

/** @internal exported for cancellation-recovery regression tests. */
export async function recoverOrCancelReleasedDrain({
  cancel,
  drain,
  onCancelled,
  retryOnCancellationFailure = true,
}: {
  readonly cancel: () => Promise<void>;
  readonly drain: () => Promise<void>;
  readonly onCancelled: () => void;
  readonly retryOnCancellationFailure?: boolean;
}): Promise<void> {
  try {
    await cancel();
    onCancelled();
  } catch {
    if (retryOnCancellationFailure) {
      await Promise.resolve();
      await retryReleasedThreadDrain(drain, () =>
        recoverOrCancelReleasedDrain({
          cancel,
          drain,
          onCancelled,
          retryOnCancellationFailure: false,
        })
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
