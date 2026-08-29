import {
  normalizedListLimit,
  type ScheduledWorkKind as SharedScheduledWorkKind,
} from "../../../../execution/scheduled-work";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type {
  DurableObjectStorage,
  DurableObjectTransactionStorage,
} from "../durable-object/durable-object-storage";
import {
  requiredSqlStorage,
  withTransaction,
} from "../durable-object/sql-access";
import { ensureScheduledWorkSchema } from "./scheduled-work-table-schema";

export type ScheduledWorkKind =
  | "agents-run"
  | "agents-thread-prompt"
  | "celld-run"
  | "celld-thread-prompt"
  | SharedScheduledWorkKind;

export interface ScheduledWorkRow {
  readonly claim_token?: string | null;
  readonly claimed_until?: number | null;
  readonly due_at?: number | null;
  readonly payload: string;
  readonly run_id?: string | null;
  readonly thread_key?: string | null;
  readonly work_id: string;
}

export interface ScheduledWorkIndexes {
  readonly dueAtMs?: number;
  readonly runId?: string;
  readonly threadKey?: string;
}

export async function insertScheduledWork(
  storage: DurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  payload: unknown,
  indexes: ScheduledWorkIndexes
): Promise<void> {
  await withTransaction(storage, (tx) => {
    insertScheduledWorkInTransaction(
      tx,
      prefix,
      kind,
      workId,
      payload,
      indexes
    );
    return Promise.resolve();
  });
}

export function insertScheduledWorkInTransaction(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  payload: unknown,
  indexes: ScheduledWorkIndexes
): void {
  insertScheduledWorkRow(
    requiredScheduledWorkTableSql(storage),
    prefix,
    kind,
    workId,
    payload,
    indexes
  );
}

export function selectScheduledWork(
  storage: DurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  limit?: number,
  offset = 0
): ScheduledWorkRow[] {
  const sql = requiredScheduledWorkTableSql(storage);
  ensureScheduledWorkSchema(sql);
  if (limit !== undefined) {
    return sql
      .exec<ScheduledWorkRow>(
        "SELECT work_id, payload, claim_token, claimed_until FROM pss_scheduled_work WHERE prefix = ? AND kind = ? ORDER BY created_at, rowid LIMIT ? OFFSET ?",
        prefix,
        kind,
        normalizedListLimit(limit),
        Math.max(0, Math.floor(offset))
      )
      .toArray();
  }
  return sql
    .exec<ScheduledWorkRow>(
      "SELECT work_id, payload, claim_token, claimed_until FROM pss_scheduled_work WHERE prefix = ? AND kind = ? ORDER BY created_at, rowid",
      prefix,
      kind
    )
    .toArray();
}

export function selectScheduledWorkDue(
  storage: DurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  nowMs: number,
  limit?: number
): ScheduledWorkRow[] {
  const sql = requiredScheduledWorkTableSql(storage);
  ensureScheduledWorkSchema(sql);
  const normalizedLimit = normalizedListLimit(limit) ?? Number.MAX_SAFE_INTEGER;
  return sql
    .exec<ScheduledWorkRow>(
      "SELECT work_id, payload, claim_token, claimed_until, due_at FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND due_at <= ? ORDER BY due_at, rowid LIMIT ?",
      prefix,
      kind,
      nowMs,
      normalizedLimit
    )
    .toArray();
}

export function selectNextScheduledWork(
  storage: DurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind
): ScheduledWorkRow | undefined {
  const sql = requiredScheduledWorkTableSql(storage);
  ensureScheduledWorkSchema(sql);
  return sql
    .exec<ScheduledWorkRow>(
      "SELECT work_id, payload, claim_token, claimed_until, due_at FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND due_at IS NOT NULL ORDER BY due_at, rowid LIMIT 1",
      prefix,
      kind
    )
    .toArray()[0];
}

export function deleteScheduledWork(
  storage: DurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): Promise<void> {
  deleteScheduledWorkRow(
    requiredScheduledWorkTableSql(storage),
    prefix,
    kind,
    workId
  );
  return Promise.resolve();
}

export async function claimScheduledWork(
  storage: DurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): Promise<boolean> {
  return await withTransaction(storage, (tx) =>
    Promise.resolve(claimScheduledWorkRow(tx, prefix, kind, workId))
  );
}

function insertScheduledWorkRow(
  sql: SqlStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  payload: unknown,
  indexes: ScheduledWorkIndexes
): void {
  ensureScheduledWorkSchema(sql);
  const existing = sql
    .exec(
      "SELECT work_id FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
      prefix,
      kind,
      workId
    )
    .toArray();
  if (existing.length > 0) {
    return;
  }
  sql.exec(
    "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    prefix,
    kind,
    workId,
    JSON.stringify(payload),
    indexes.threadKey ?? null,
    indexes.runId ?? null,
    indexes.dueAtMs ?? null,
    Date.now()
  );
}

function claimScheduledWorkRow(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): boolean {
  const sql = requiredScheduledWorkTableSql(storage);
  ensureScheduledWorkSchema(sql);
  const existing = sql
    .exec<ScheduledWorkRow>(
      "SELECT work_id FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
      prefix,
      kind,
      workId
    )
    .toArray();
  if (existing.length === 0) {
    return false;
  }
  deleteScheduledWorkRow(sql, prefix, kind, workId);
  return true;
}

function deleteScheduledWorkRow(
  sql: SqlStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): void {
  ensureScheduledWorkSchema(sql);
  sql.exec(
    "DELETE FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
    prefix,
    kind,
    workId
  );
}

function requiredScheduledWorkTableSql(
  storage: DurableObjectTransactionStorage
): SqlStorage {
  return requiredSqlStorage(storage, "Durable Object scheduled work queue");
}
