import type {
  TurnRecord,
  TurnStatus,
  TurnTransitionExpected,
  TurnTransitionResult,
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

export function decideTurnTransition(
  record: TurnRecord | null,
  expected: TurnTransitionExpected
): Exclude<TurnTransitionResult, { ok: true }> | null {
  if (!record) {
    return { ok: false, reason: "not-found" };
  }
  if (expected.status !== undefined && record.status !== expected.status) {
    return { ok: false, reason: "status-conflict" };
  }
  if (
    expected.leaseId !== undefined &&
    (record.lease?.leaseId ?? null) !== expected.leaseId
  ) {
    return { ok: false, reason: "lease-conflict" };
  }
  if (
    expected.checkpointVersion !== undefined &&
    record.checkpointVersion !== expected.checkpointVersion
  ) {
    return { ok: false, reason: "checkpoint-conflict" };
  }
  return null;
}
