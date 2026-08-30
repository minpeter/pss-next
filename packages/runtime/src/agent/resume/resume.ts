import { transitionTurn } from "../../execution/host/turn-status";
import { TurnTransitionConflictError } from "../../execution/host/turn-transition-conflict";
import type {
  AgentHost,
  NotificationInbox,
  NotificationRecord,
  TurnLease,
  TurnRecord,
  TurnStore,
} from "../../execution/host/types";
import type { AgentTurn } from "../../thread/protocol/turn";
import { ownsAgentNamespace } from "../identity/namespace";
import { leaseIdForResumeClaim } from "./retry-authority";

export type ClaimedTurnRecord = TurnRecord & {
  readonly lease: TurnLease;
};

interface ResumeAgentTurnInput {
  readonly claim?: object;
  readonly host: AgentHost;
  readonly ownerNamespace: string;
  resumeNotification(
    notification: NotificationRecord,
    run: ClaimedTurnRecord
  ): Promise<AgentTurn>;
  readonly runId: string;
}

export async function resumeAgentTurn({
  claim,
  host,
  ownerNamespace,
  resumeNotification,
  runId,
}: ResumeAgentTurnInput): Promise<AgentTurn | null> {
  const retryLeaseId = leaseIdForResumeClaim(claim, runId);
  const run = await host.store.turns.get(runId);
  if (!run) {
    return null;
  }
  if (!canAccessRun(run, ownerNamespace)) {
    return null;
  }

  if (run.kind === "notification" && run.dedupeKey) {
    const idempotencyKey = run.dedupeKey;
    const claimedTuple = await host.store.transaction(async (transaction) => {
      const claimed = await claimRun(transaction.turns, run, retryLeaseId);
      if (!claimed) {
        return null;
      }

      const notificationClaim = await claimNotificationForRun(
        transaction.notifications,
        idempotencyKey
      );
      if (!notificationClaim) {
        await requeueClaimedRun(transaction.turns, claimed);
        return null;
      }
      const notification = notificationClaim.record;
      if (
        claimed.kind !== "notification" ||
        claimed.dedupeKey === undefined ||
        notification.idempotencyKey !== claimed.dedupeKey ||
        notification.runId !== claimed.runId ||
        notification.threadKey !== claimed.threadKey ||
        notification.ownerNamespace !== claimed.ownerNamespace ||
        !ownsAgentNamespace(claimed.ownerNamespace, ownerNamespace) ||
        notification.notificationId.length === 0
      ) {
        if (notificationClaim.release) {
          await transaction.notifications.releaseByIdempotencyKey(
            idempotencyKey
          );
        }
        await requeueClaimedRun(transaction.turns, claimed);
        return null;
      }

      return { notification: notificationClaim.record, run: claimed };
    });
    if (!claimedTuple) {
      return null;
    }
    const { notification, run: claimed } = claimedTuple;

    try {
      const notificationRun = await resumeNotification(notification, claimed);
      if (notificationRun.runId !== claimed.runId) {
        await completeNotificationRun(
          host,
          claimed.runId,
          claimed.lease.leaseId
        );
      }
      return notificationRun;
    } catch (error) {
      await host.store.notifications.releaseByIdempotencyKey(idempotencyKey);
      throw error;
    }
  }

  return null;
}

interface ClaimedNotification {
  readonly record: NotificationRecord;
  readonly release: boolean;
}

async function claimNotificationForRun(
  notifications: NotificationInbox,
  idempotencyKey: string
): Promise<ClaimedNotification | null> {
  const claim = await notifications.claimByIdempotencyKey(idempotencyKey);
  if (claim.ok) {
    return { record: claim.record, release: true };
  }
  if (claim.reason === "already-claimed" && claim.record) {
    return { record: claim.record, release: false };
  }
  return null;
}

async function requeueClaimedRun(
  turns: TurnStore,
  run: TurnRecord
): Promise<void> {
  const transition = await transitionTurn(turns, {
    expected: {
      leaseId: run.lease?.leaseId ?? null,
      status: run.status,
    },
    runId: run.runId,
    update: { lease: null, status: "queued" },
  });
  if (!transition.ok) {
    throw new TurnTransitionConflictError(
      run.runId,
      "notification",
      transition.reason
    );
  }
}

function canAccessRun(run: TurnRecord, ownerNamespace: string): boolean {
  // Owner-less runs are denied: ownsAgentNamespace(undefined, …) is false,
  // and there is no parent-threadKey fallback.
  return ownsAgentNamespace(run.ownerNamespace, ownerNamespace);
}

export async function completeNotificationRun(
  host: AgentHost,
  runId: string,
  leaseId: string | null
): Promise<void> {
  const run = await host.store.turns.get(runId);
  if (
    run?.kind !== "notification" ||
    run.status === "cancelled" ||
    run.status === "completed" ||
    run.status === "error" ||
    run.status === "needs-recovery"
  ) {
    return;
  }

  const transition = await transitionTurn(host.store.turns, {
    expected: { leaseId, status: run.status },
    runId,
    update: { status: "completed" },
  });
  if (!transition.ok) {
    throw new TurnTransitionConflictError(
      runId,
      "notification",
      transition.reason
    );
  }
}

async function claimRun(
  turns: TurnStore,
  run: TurnRecord,
  retryLeaseId: string | undefined
): Promise<ClaimedTurnRecord | null> {
  const result = await turns.claim(run.runId, {
    attempt: (run.lease?.attempt ?? 0) + 1,
    leaseId: retryLeaseId ?? crypto.randomUUID(),
    leaseMs: 300_000,
    nowMs: Date.now(),
  });
  return result.ok ? { ...result.record, lease: result.lease } : null;
}
