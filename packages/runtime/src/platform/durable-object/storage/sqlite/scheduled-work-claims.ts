import type { SqlStorage } from "../../sql/ports/storage-port";
import type {
  DurableObjectStorage,
  DurableObjectTransactionStorage,
} from "../durable-object/durable-object-storage";
import {
  requiredSqlStorage,
  withTransaction,
} from "../durable-object/sql-access";
import type {
  ScheduledWorkKind,
  ScheduledWorkRow,
} from "./scheduled-work-table";
import { ensureScheduledWorkSchema } from "./scheduled-work-table-schema";

export const SCHEDULED_WORK_LEASE_MS = 120_000;

export async function claimScheduledWorkLease(
  storage: DurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  nowMs = Date.now(),
  leaseMs = SCHEDULED_WORK_LEASE_MS
): Promise<string | undefined> {
  const token = crypto.randomUUID();
  return await withTransaction(storage, async (tx) => {
    const sql = requiredClaimSql(tx);
    ensureScheduledWorkSchema(sql);
    const leaseUntil = nowMs + Math.max(1, Math.floor(leaseMs));
    sql.exec(
      "UPDATE pss_scheduled_work SET claim_token = ?, claimed_until = ?, due_at = ? WHERE prefix = ? AND kind = ? AND work_id = ? AND (claimed_until IS NULL OR claimed_until <= ?)",
      token,
      leaseUntil,
      leaseUntil,
      prefix,
      kind,
      workId,
      nowMs
    );
    const claimed = sql
      .exec<ScheduledWorkRow>(
        "SELECT claim_token FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
        prefix,
        kind,
        workId
      )
      .toArray()[0]?.claim_token;
    if (claimed !== token) {
      return;
    }
    await armScheduledWorkTransaction(tx, sql, prefix);
    return token;
  });
}

export async function releaseScheduledWorkLease(
  storage: DurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  claimToken: string,
  dueAtMs: number
): Promise<boolean> {
  return await withTransaction(storage, async (tx) => {
    const sql = requiredClaimSql(tx);
    ensureScheduledWorkSchema(sql);
    const payload = sql
      .exec<ScheduledWorkRow>(
        "SELECT payload FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ? AND claim_token = ?",
        prefix,
        kind,
        workId,
        claimToken
      )
      .toArray()[0]?.payload;
    if (payload === undefined) {
      return false;
    }
    sql.exec(
      "UPDATE pss_scheduled_work SET claim_token = NULL, claimed_until = NULL, payload = ?, due_at = ?, created_at = ? WHERE prefix = ? AND kind = ? AND work_id = ? AND claim_token = ?",
      withDueAt(payload, dueAtMs),
      dueAtMs,
      dueAtMs,
      prefix,
      kind,
      workId,
      claimToken
    );
    await armScheduledWorkTransaction(tx, sql, prefix);
    return true;
  });
}

function withDueAt(payload: string, dueAtMs: number): string {
  const value: unknown = JSON.parse(payload);
  if (typeof value !== "object" || value === null || !("value" in value)) {
    throw new Error("Invalid scheduled work payload.");
  }
  return JSON.stringify({
    dueAtMs: Math.max(0, Math.floor(dueAtMs)),
    value: value.value,
  });
}

export async function ackScheduledWorkLease(
  storage: DurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  claimToken: string
): Promise<boolean> {
  return await withTransaction(storage, async (tx) => {
    const sql = requiredClaimSql(tx);
    ensureScheduledWorkSchema(sql);
    if (!hasClaim(sql, prefix, kind, workId, claimToken)) {
      return false;
    }
    sql.exec(
      "DELETE FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ? AND claim_token = ?",
      prefix,
      kind,
      workId,
      claimToken
    );
    await armScheduledWorkTransaction(tx, sql, prefix);
    return true;
  });
}

async function armScheduledWorkTransaction(
  storage: DurableObjectTransactionStorage,
  sql: SqlStorage,
  prefix: string
): Promise<void> {
  const next = earliestScheduledAt(sql, prefix);
  if (next === undefined) {
    return;
  }
  if (storage.setAlarm === undefined) {
    throw new Error("Celld storage transaction setAlarm() is required.");
  }
  await storage.setAlarm(next);
}

function earliestScheduledAt(
  sql: SqlStorage,
  prefix: string
): number | undefined {
  const times = (["celld-run", "celld-thread-prompt"] as const).flatMap(
    (kind) => {
      const row = sql
        .exec<ScheduledWorkRow>(
          "SELECT due_at FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND due_at IS NOT NULL ORDER BY due_at, rowid LIMIT 1",
          prefix,
          kind
        )
        .toArray()[0];
      return typeof row?.due_at === "number" ? [row.due_at] : [];
    }
  );
  return times.length === 0 ? undefined : Math.min(...times);
}

function hasClaim(
  sql: SqlStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  claimToken: string
): boolean {
  return (
    sql
      .exec(
        "SELECT claim_token FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ? AND claim_token = ?",
        prefix,
        kind,
        workId,
        claimToken
      )
      .toArray().length > 0
  );
}

function requiredClaimSql(
  storage: DurableObjectTransactionStorage
): SqlStorage {
  return requiredSqlStorage(storage, "Durable Object scheduled work claims");
}
