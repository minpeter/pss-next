import type { AgentHost } from "../../execution/host/types";
import { Fsm } from "../../fsm";
import { assertNever } from "../../internal/guards";
import {
  cancelRecoveryLease,
  leaseRecoveryFlight,
  type RecoveryLease,
} from "./durable-queue-recovery-flight";
import { isThreadDrainOwned } from "./thread-drain-coordinator";

/**
 * One-shot recovery of orphaned durable input claims:
 * `pending -> recovering -> recovered`, rolling back to `pending` when the
 * exact recovery lease fails or is cancelled so the next admission retries.
 */
type DurableInputRecoveryPhase =
  | { readonly tag: "pending" }
  | {
      readonly lease: RecoveryLease;
      readonly promise: Promise<void>;
      readonly tag: "recovering";
    }
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
  signal,
  state,
  threadKey,
}: {
  readonly allowOwned?: boolean;
  readonly executionHost: AgentHost | undefined;
  readonly signal?: AbortSignal;
  readonly state: DurableInputRecoveryState;
  readonly threadKey: string;
}): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
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

  const lease = leaseRecoveryFlight(executionHost, threadKey);
  let removeAbortListener = (): void => undefined;
  const promise = lease.settled.promise.then(
    () => {
      removeAbortListener();
      transitionExactLease(state, lease, "recovered");
    },
    (error: unknown) => {
      removeAbortListener();
      transitionExactLease(state, lease, "pending");
      throw error;
    }
  );
  state.machine.to({ lease, promise, tag: "recovering" });
  if (signal) {
    const abortFromCaller = (): void => {
      if (!lease.active) {
        return;
      }
      transitionExactLease(state, lease, "pending");
      cancelRecoveryLease(lease, signal.reason);
    };
    signal.addEventListener("abort", abortFromCaller, { once: true });
    removeAbortListener = () =>
      signal.removeEventListener("abort", abortFromCaller);
    if (signal.aborted) {
      abortFromCaller();
    }
  }
  return promise;
}

function transitionExactLease(
  state: DurableInputRecoveryState,
  lease: RecoveryLease,
  target: "pending" | "recovered"
): void {
  const current = state.machine.state;
  if (current.tag === "recovering" && current.lease === lease) {
    state.machine.to({ tag: target });
  }
}
