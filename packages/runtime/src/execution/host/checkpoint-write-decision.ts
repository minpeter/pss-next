import { assertNever } from "../../internal/guards";
import type {
  Checkpoint,
  CheckpointWriteResult,
  LeaseFencedCheckpointWriteOptions,
  LeaseFencedCheckpointWriteResult,
  TurnRecord,
  TurnStatus,
} from "./types";

export function decideCheckpointVersionWrite(
  currentVersion: number,
  expectedVersion: number
):
  | { readonly ok: true }
  | Exclude<CheckpointWriteResult, { readonly ok: true }> {
  if (expectedVersion !== currentVersion) {
    return { currentVersion, ok: false, reason: "stale-version" };
  }
  return { ok: true };
}

export function decideLeaseFencedCheckpointWrite(
  addressedRunId: string,
  run: TurnRecord | null,
  checkpoint: Checkpoint,
  options: LeaseFencedCheckpointWriteOptions
):
  | { readonly ok: true; readonly run: TurnRecord }
  | Exclude<LeaseFencedCheckpointWriteResult, { readonly ok: true }> {
  if (!run || run.runId !== addressedRunId) {
    return { ok: false, reason: "not-found" };
  }
  if (isTerminalStatus(run.status)) {
    return { ok: false, reason: "status-conflict" };
  }
  if ((run.lease?.leaseId ?? null) !== options.expectedLeaseId) {
    return { ok: false, reason: "lease-conflict" };
  }

  const currentVersion = run.checkpointVersion;
  if (
    options.expectedVersion !== currentVersion ||
    !Number.isSafeInteger(checkpoint.version) ||
    checkpoint.version <= 0 ||
    checkpoint.version !== currentVersion + 1
  ) {
    return { currentVersion, ok: false, reason: "stale-version" };
  }
  return { ok: true, run };
}

function isTerminalStatus(status: TurnStatus): boolean {
  switch (status) {
    case "cancelled":
    case "completed":
    case "error":
    case "needs-recovery":
      return true;
    case "leased":
    case "queued":
    case "running":
    case "suspended":
      return false;
    default:
      return assertNever(status);
  }
}
