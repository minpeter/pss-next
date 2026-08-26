import { deferred } from "../../internal/deferred";
import type { AgentInput } from "../input/input";
import { type AgentTurn, BufferedAgentTurn } from "../protocol/turn";
import { reserveThreadInputAdmission } from "../runtime/thread-input-admission-coordinator";
import type { AgentThreadContext } from "./agent-thread-context";
import { drainAgentThreadInputQueue } from "./agent-thread-drain";
import {
  assertAgentThreadOpen,
  ensureAgentThreadStarted,
} from "./agent-thread-lifecycle";
import { recoverThreadDurableInputClaims } from "./durable-queue-claims";
import { admitThreadSendInput } from "./durable-queue-send";

export async function queueAgentThreadInput(
  context: AgentThreadContext,
  input: AgentInput,
  kind: "follow-up" | "send"
): Promise<AgentTurn> {
  assertAgentThreadOpen(context);

  const run = new BufferedAgentTurn();
  const executionHost = context.execution.executionHost;
  const reservation = executionHost
    ? reserveThreadInputAdmission(executionHost, context.threadKey)
    : undefined;
  const loaded = ensureAgentThreadStarted(context);
  await enqueueAgentThreadInputAdmission(context, async () => {
    const admit = async (): Promise<void> => {
      await loaded;
      assertAgentThreadOpen(context);
      await recoverAgentThreadDurableInputClaims(context);
      assertAgentThreadOpen(context);

      // Skip awaiting turn boundaries when the drain loop is running without
      // an active turn: the boundary events would never be acknowledged.
      const idleDrainLoop =
        context.drain.state.tag === "draining" &&
        context.turn.state.tag !== "active";
      await admitThreadSendInput({
        awaitBoundaries: !idleDrainLoop,
        drain: () => drainAgentThreadInputQueue(context),
        events: context.events,
        executionHost: context.execution.executionHost,
        attachmentStore: context.model.attachmentStore,
        input,
        inputQueue: context.inputQueue,
        kind,
        pendingOverlays: context.pendingOverlays,
        pendingRuntimeInputs: context.pendingRuntimeInputs,
        reservation: async (operation) => operation(),
        run,
        threadKey: context.threadKey,
      });
      assertAgentThreadOpen(context);
    };
    await (reservation ? reservation(admit) : admit());
  });
  return run;
}

export async function enqueueAgentThreadInputAdmission<T>(
  context: AgentThreadContext,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const previous = context.inputAdmissionQueue;
  const released = deferred();
  context.inputAdmissionQueue = previous.then(() => released.promise);
  try {
    if (signal) {
      signal.throwIfAborted();
      const aborted = deferred<never>();
      const abortFromCaller = (): void => aborted.reject(signal.reason);
      signal.addEventListener("abort", abortFromCaller, { once: true });
      try {
        await Promise.race([previous, aborted.promise]);
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", abortFromCaller);
      }
    } else {
      await previous;
    }
    return await operation();
  } finally {
    released.resolve();
  }
}

export async function recoverAgentThreadDurableInputClaims(
  context: AgentThreadContext
): Promise<void> {
  await recoverThreadDurableInputClaims({
    executionHost: context.execution.executionHost,
    state: context.durableInputRecovery,
    threadKey: context.threadKey,
  });
}
