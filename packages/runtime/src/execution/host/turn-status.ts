import type {
  TurnRecord,
  TurnStatus,
  TurnStore,
  TurnTransitionExpected,
  TurnTransitionResult,
  TurnTransitionUpdate,
} from "./types";

const CLAIMABLE_TURN_STATUSES = new Set<TurnStatus>([
  "leased",
  "queued",
  "running",
  "suspended",
]);

export function decideTurnClaim(
  record: TurnRecord,
  nowMs: number
): { ok: true } | { ok: false; reason: "leased" | "not-claimable" } {
  if (!CLAIMABLE_TURN_STATUSES.has(record.status)) {
    return { ok: false, reason: "not-claimable" };
  }
  if (record.lease && record.lease.leaseUntilMs > nowMs) {
    return { ok: false, reason: "leased" };
  }
  return { ok: true };
}

export function applyTurnTransitionUpdate(
  current: TurnRecord,
  update: TurnTransitionUpdate
): TurnRecord {
  if (update.lease === undefined) {
    return { ...current, status: update.status };
  }
  if (update.lease !== null) {
    return { ...current, lease: update.lease, status: update.status };
  }
  const { lease: _lease, ...withoutLease } = current;
  return { ...withoutLease, status: update.status };
}

export function decideTurnTransition(
  current: TurnRecord,
  expected: TurnTransitionExpected
): Exclude<TurnTransitionResult, { ok: true }> | null {
  if (expected.status !== undefined && current.status !== expected.status) {
    return { ok: false, reason: "status-conflict" };
  }
  if (
    expected.leaseId !== undefined &&
    (current.lease?.leaseId ?? null) !== expected.leaseId
  ) {
    return { ok: false, reason: "lease-conflict" };
  }
  if (
    expected.checkpointVersion !== undefined &&
    current.checkpointVersion !== expected.checkpointVersion
  ) {
    return { ok: false, reason: "checkpoint-conflict" };
  }
  return null;
}

export async function transitionTurn(
  turns: TurnStore,
  transition: {
    readonly expected: TurnTransitionExpected;
    readonly runId: string;
    readonly update: TurnTransitionUpdate;
  }
): Promise<TurnTransitionResult> {
  if (turns.transition) {
    return await turns.transition(
      transition.runId,
      transition.expected,
      transition.update
    );
  }
  const current = await turns.get(transition.runId);
  if (!current) {
    return { ok: false, reason: "not-found" };
  }
  const conflict = decideTurnTransition(current, transition.expected);
  if (conflict) {
    return conflict;
  }
  const record = await turns.update(
    applyTurnTransitionUpdate(current, transition.update)
  );
  return { ok: true, record };
}
