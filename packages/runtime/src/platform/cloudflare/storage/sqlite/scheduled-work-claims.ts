import type { SqlStorage } from "../../sql/ports/storage-port";
import type {
  CloudflareDurableObjectStorage,
  CloudflareDurableObjectTransactionStorage,
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
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  nowMs = Date.now(),
  leaseMs = SCHEDULED_WORK_LEASE_MS
): Promise<string | undefined> {
  const token = crypto.randomUUID();
  return await withTransaction(storage, (tx) => {
    const sql = requiredClaimSql(tx);
    ensureScheduledWorkSchema(sql);
    const leaseUntil = nowMs + Math.max(1, Math.floor(leaseMs));
    sql.exec(
      "UPDATE pss_scheduled_work SET claim_token = ?, claimed_until = ? WHERE prefix = ? AND kind = ? AND work_id = ? AND (claimed_until IS NULL OR claimed_until <= ?)",
      token,
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
    return Promise.resolve(claimed === token ? token : undefined);
  });
}

export async function releaseScheduledWorkLease(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  claimToken: string,
  dueAtMs: number
): Promise<boolean> {
  return await withTransaction(storage, (tx) => {
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
      return Promise.resolve(false);
    }
    sql.exec(
      "UPDATE pss_scheduled_work SET claim_token = NULL, claimed_until = NULL, payload = ?, created_at = ? WHERE prefix = ? AND kind = ? AND work_id = ? AND claim_token = ?",
      withDueAt(payload, dueAtMs),
      dueAtMs,
      prefix,
      kind,
      workId,
      claimToken
    );
    return Promise.resolve(
      hasClaim(sql, prefix, kind, workId, claimToken) === false
    );
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
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  claimToken: string
): Promise<boolean> {
  return await withTransaction(storage, (tx) => {
    const sql = requiredClaimSql(tx);
    ensureScheduledWorkSchema(sql);
    sql.exec(
      "DELETE FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ? AND claim_token = ?",
      prefix,
      kind,
      workId,
      claimToken
    );
    return Promise.resolve(
      hasClaim(sql, prefix, kind, workId, claimToken) === false
    );
  });
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
  storage: CloudflareDurableObjectTransactionStorage
): SqlStorage {
  return requiredSqlStorage(storage, "Cloudflare scheduled work claims");
}
