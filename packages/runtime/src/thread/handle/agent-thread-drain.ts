import type { AgentThreadContext } from "./agent-thread-context";
import { runThreadInputDrainLoop } from "./thread-drain";

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

  let finishLoop!: () => void;
  let failLoop!: (error: unknown) => void;
  const loopSettled = new Promise<void>((resolve, reject) => {
    finishLoop = resolve;
    failLoop = reject;
  });
  loopSettled.catch(() => undefined);
  drain.to({ tag: "draining", promise: loopSettled, restartRequested: false });

  const loop = runThreadInputDrainLoop({
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
    release: () => {
      turn.to({ tag: "none" });
    },
    state: context.state,
    threadKey: context.threadKey,
  });
  loop.then(finishLoop, failLoop);

  try {
    await loop;
  } finally {
    const state = drain.state;
    const shouldRestart =
      state.tag === "draining" &&
      state.restartRequested &&
      terminal.state.tag === "open";
    drain.to({ tag: "idle" });
    if (shouldRestart) {
      await drainAgentThreadInputQueue(context);
    }
  }
}
