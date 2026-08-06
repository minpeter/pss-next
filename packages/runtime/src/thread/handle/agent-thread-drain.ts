import { deferred } from "../../internal/deferred";
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
          released.then(
            () => drainAgentThreadInputQueue(context),
            () => undefined
          );
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
