import type {
  AgentHost,
  NotificationRecord,
  TurnRecord,
} from "../../execution/host/types";
import type { AgentTurn } from "../../thread/protocol/turn";
import { ownsAgentNamespace } from "../identity/namespace";

interface ResumeAgentTurnInput {
  readonly host: AgentHost;
  readonly ownerNamespace: string;
  resumeNotification(
    notification: NotificationRecord,
    run: TurnRecord
  ): Promise<AgentTurn>;
  readonly runId: string;
}

export async function resumeAgentTurn({
  host,
  ownerNamespace,
  resumeNotification,
  runId,
}: ResumeAgentTurnInput): Promise<AgentTurn | null> {
  const run = await host.store.turns.get(runId);
  if (!run) {
    return null;
  }
  if (!canAccessRun(run, ownerNamespace)) {
    return null;
  }

  if (run.kind === "notification" && run.dedupeKey) {
    const idempotencyKey = run.dedupeKey;
    const claimed = await claimRun(host, run);
    if (!claimed) {
      return null;
    }

    const notification = await claimNotificationForRun({
      host,
      idempotencyKey,
      ownerNamespace,
    });
    if (!notification) {
      return null;
    }

    try {
      const notificationRun = await resumeNotification(notification, claimed);
      if (notificationRun.runId !== claimed.runId) {
        await completeNotificationRun(host, claimed.runId);
      }
      return notificationRun;
    } catch (error) {
      await host.store.notifications.releaseByIdempotencyKey(idempotencyKey);
      throw error;
    }
  }

  return null;
}

async function claimNotificationForRun({
  host,
  idempotencyKey,
  ownerNamespace,
}: {
  readonly host: AgentHost;
  readonly idempotencyKey: string;
  readonly ownerNamespace: string;
}): Promise<NotificationRecord | null> {
  const current =
    await host.store.notifications.getByIdempotencyKey(idempotencyKey);
  if (!ownsAgentNamespace(current?.ownerNamespace, ownerNamespace)) {
    return null;
  }

  const claim =
    await host.store.notifications.claimByIdempotencyKey(idempotencyKey);
  if (claim.ok) {
    if (ownsAgentNamespace(claim.record.ownerNamespace, ownerNamespace)) {
      return claim.record;
    }
    await host.store.notifications.releaseByIdempotencyKey(idempotencyKey);
    return null;
  }

  if (
    claim.reason === "already-claimed" &&
    ownsAgentNamespace(claim.record?.ownerNamespace, ownerNamespace)
  ) {
    return claim.record ?? null;
  }

  return null;
}

function canAccessRun(run: TurnRecord, ownerNamespace: string): boolean {
  // Owner-less runs are denied: ownsAgentNamespace(undefined, …) is false,
  // and there is no parent-threadKey fallback.
  return ownsAgentNamespace(run.ownerNamespace, ownerNamespace);
}

export async function completeNotificationRun(
  host: AgentHost,
  runId: string
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

  const transition = await host.store.turns.transition(
    runId,
    { leaseId: run.lease?.leaseId, status: run.status },
    { ...run, status: "completed" }
  );
  if (!transition.ok) {
    throw new Error(
      `Notification run ${runId} transition failed: ${transition.reason}.`
    );
  }
}

async function claimRun(
  host: AgentHost,
  run: TurnRecord
): Promise<TurnRecord | null> {
  const claim = await host.store.turns.claim(run.runId, {
    attempt: (run.lease?.attempt ?? 0) + 1,
    leaseId: crypto.randomUUID(),
    leaseMs: 300_000,
    nowMs: Date.now(),
  });
  return claim.ok ? claim.record : null;
}
