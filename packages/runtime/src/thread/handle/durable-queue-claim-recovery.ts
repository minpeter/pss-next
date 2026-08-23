import type { AgentHost } from "../../execution/host/types";
import { Fsm } from "../../fsm";
import { assertNever } from "../../internal/guards";
import { recoverDurableThreadInputs } from "../runtime/durable-input-claims";
import { isThreadDrainOwned } from "./thread-drain-coordinator";

const sharedRecoveries = new WeakMap<object, Map<string, Promise<void>>>();

async function recoverAfterLiveDrain(
  executionHost: AgentHost,
  threadKey: string
): Promise<void> {
  let byThread = sharedRecoveries.get(executionHost.store);
  if (!byThread) {
    byThread = new Map();
    sharedRecoveries.set(executionHost.store, byThread);
  }
  const existing = byThread.get(threadKey);
  if (existing) {
    return await existing;
  }
  const recovery = (async () => {
    await recoverDurableThreadInputs({ executionHost, threadKey });
  })();
  byThread.set(threadKey, recovery);
  try {
    await recovery;
  } finally {
    if (byThread.get(threadKey) === recovery) {
      byThread.delete(threadKey);
    }
  }
}

/**
 * One-shot recovery of orphaned durable input claims:
 * `pending -> recovering -> recovered`, rolling back to `pending` when the
 * recovery fails so the next admission retries it.
 */
type DurableInputRecoveryPhase =
  | { readonly tag: "pending" }
  | { readonly promise: Promise<void>; readonly tag: "recovering" }
  | { readonly tag: "recovered" };

export class DurableInputRecoveryState {
  readonly machine = new Fsm<DurableInputRecoveryPhase>({
    initial: { tag: "pending" },
    name: "durable-input-recovery",
    transitions: {
      pending: ["recovering"],
      recovering: ["recovered", "pending"],
      recovered: [],
    },
  });
}

export function recoverThreadDurableInputClaims({
  allowOwned = false,
  executionHost,
  state,
  threadKey,
}: {
  readonly allowOwned?: boolean;
  readonly executionHost: AgentHost | undefined;
  readonly state: DurableInputRecoveryState;
  readonly threadKey: string;
}): Promise<void> {
  const current = state.machine.state;
  switch (current.tag) {
    case "recovering":
      return current.promise;
    case "recovered":
      return Promise.resolve();
    case "pending":
      break;
    default:
      return assertNever(current);
  }
  if (
    executionHost &&
    !allowOwned &&
    isThreadDrainOwned(executionHost, threadKey)
  ) {
    return Promise.resolve();
  }

  const recovery: Promise<void> = (
    executionHost
      ? recoverAfterLiveDrain(executionHost, threadKey)
      : recoverDurableThreadInputs({ executionHost, threadKey })
  ).then(
    () => {
      state.machine.to({ tag: "recovered" });
    },
    (error: unknown) => {
      state.machine.to({ tag: "pending" });
      throw error;
    }
  );
  state.machine.to({ promise: recovery, tag: "recovering" });
  return recovery;
}
