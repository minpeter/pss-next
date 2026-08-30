import { transitionTurn } from "../../execution/host/turn-status";
import { TurnTransitionConflictError } from "../../execution/host/turn-transition-conflict";
import type {
  AgentHost,
  HostStoreTransaction,
  TurnStatus,
} from "../../execution/host/types";
import type { CommitResult } from "../store/types";

export type OwnedRunStorageCommit<Result = void> = (
  tx: HostStoreTransaction
) => Promise<Result>;

export type TerminalRunStorageCommit = (
  tx: HostStoreTransaction
) => Promise<CommitResult>;

interface TerminalRunSettlement {
  readonly executionHost: AgentHost;
  readonly leaseId: string | null;
  readonly persist?: TerminalRunStorageCommit;
  readonly runId: string;
  readonly status: Extract<
    TurnStatus,
    "cancelled" | "completed" | "error" | "needs-recovery"
  >;
}

export async function commitOwnedThreadExecutionRunStorage<Result>({
  executionHost,
  leaseId,
  persist,
  runId,
}: {
  readonly executionHost: AgentHost;
  readonly leaseId: string | null;
  readonly persist: OwnedRunStorageCommit<Result>;
  readonly runId: string;
}): Promise<Result> {
  return await executionHost.store.transaction(async (tx) => {
    const run = await tx.turns.get(runId);
    if (!run) {
      throw new TurnTransitionConflictError(runId, "complete", "not-found");
    }
    if (run.status !== "running") {
      throw new TurnTransitionConflictError(
        runId,
        "complete",
        "status-conflict"
      );
    }
    if ((run.lease?.leaseId ?? null) !== leaseId) {
      throw new TurnTransitionConflictError(
        runId,
        "complete",
        "lease-conflict"
      );
    }
    return await persist(tx);
  });
}

export async function completeThreadExecutionRun(
  settlement: TerminalRunSettlement
): Promise<void> {
  const run = await settlement.executionHost.store.turns.get(settlement.runId);
  if (!run || isTerminalTurnStatus(run.status)) {
    return;
  }
  await settleThreadExecutionRun(settlement);
}

export function settleThreadExecutionRun(
  settlement: TerminalRunSettlement & {
    readonly persist: TerminalRunStorageCommit;
  }
): Promise<CommitResult>;
export function settleThreadExecutionRun(
  settlement: TerminalRunSettlement
): Promise<undefined>;
export async function settleThreadExecutionRun({
  executionHost,
  leaseId,
  persist,
  runId,
  status,
}: TerminalRunSettlement): Promise<CommitResult | undefined> {
  return await executionHost.store.transaction(async (tx) => {
    const run = await tx.turns.get(runId);
    if (!run) {
      if (persist) {
        throw new TurnTransitionConflictError(runId, "complete", "not-found");
      }
      return;
    }
    if (isTerminalTurnStatus(run.status)) {
      if (persist) {
        throw new TurnTransitionConflictError(
          runId,
          "complete",
          "status-conflict"
        );
      }
      return;
    }

    const result = await persist?.(tx);
    if (result && !result.ok) {
      return result;
    }

    const transition = await transitionTurn(tx.turns, {
      expected: { leaseId, status: run.status },
      runId,
      update: { status },
    });
    if (!transition.ok) {
      throw new TurnTransitionConflictError(
        runId,
        "complete",
        transition.reason
      );
    }
    return result;
  });
}

export function isTerminalTurnStatus(status: TurnStatus): boolean {
  return (
    status === "cancelled" ||
    status === "completed" ||
    status === "error" ||
    status === "needs-recovery"
  );
}
