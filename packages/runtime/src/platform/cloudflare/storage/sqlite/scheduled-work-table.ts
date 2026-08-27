import {
  normalizedListLimit,
  type ScheduledWorkKind as SharedScheduledWorkKind,
} from "../../../../execution/scheduled-work";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type {
  CloudflareDurableObjectStorage,
  CloudflareDurableObjectTransactionStorage,
} from "../durable-object/durable-object-storage";
import {
  requiredSqlStorage,
  withTransaction,
} from "../durable-object/sql-access";
import { hasScheduledWorkColumn } from "./scheduled-work-table-schema";

export type ScheduledWorkKind =
  | "agents-run"
  | "agents-thread-prompt"
  | "celld-run"
  | "celld-thread-prompt"
  | SharedScheduledWorkKind;

export interface ScheduledWorkRow {
  readonly payload: string;
  readonly run_id?: string | null;
  readonly thread_key?: string | null;
  readonly work_id: string;
}

export interface ScheduledWorkIndexes {
  readonly runId?: string;
  readonly threadKey?: string;
}

export async function insertScheduledWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  payload: unknown,
  indexes: ScheduledWorkIndexes
): Promise<void> {
  await withTransaction(storage, (tx) => {
    insertScheduledWorkRow(
      requiredScheduledWorkTableSql(tx),
      prefix,
      kind,
      workId,
      payload,
      indexes
    );
    return Promise.resolve();
  });
}

export function selectScheduledWork(
  storage: CloudflareDurableObjectStorage,
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
        "SELECT work_id, payload FROM pss_scheduled_work WHERE prefix = ? AND kind = ? ORDER BY created_at, rowid LIMIT ? OFFSET ?",
        prefix,
        kind,
        normalizedListLimit(limit),
        Math.max(0, Math.floor(offset))
      )
      .toArray();
  }
  return sql
    .exec<ScheduledWorkRow>(
      "SELECT work_id, payload FROM pss_scheduled_work WHERE prefix = ? AND kind = ? ORDER BY created_at, rowid",
      prefix,
      kind
    )
    .toArray();
}

export function deleteScheduledWork(
  storage: CloudflareDurableObjectStorage,
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
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): Promise<boolean> {
  return await withTransaction(storage, (tx) =>
    Promise.resolve(claimScheduledWorkRow(tx, prefix, kind, workId))
  );
}

export interface ScheduledWorkTarget {
  readonly kind: ScheduledWorkKind;
  readonly matchesPayload?: (payload: string) => boolean;
  readonly workId: string;
}

// Deletes every row matching any target in ONE transaction, so a claim that
// spans two kinds (an agents row plus its alarm-interop counterpart) cannot
// be split by a crash. Returns whether at least one row was deleted.
export async function deleteScheduledWorkGroup(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  targets: readonly ScheduledWorkTarget[]
): Promise<boolean> {
  return await withTransaction(storage, (tx) => {
    const sql = requiredScheduledWorkTableSql(tx);
    ensureScheduledWorkSchema(sql);
    let deleted = false;
    for (const target of targets) {
      for (const row of matchingScheduledWorkRows(sql, prefix, target)) {
        deleteScheduledWorkRow(sql, prefix, target.kind, row.work_id);
        deleted = true;
      }
    }
    return Promise.resolve(deleted);
  });
}

export function hasScheduledWorkGroup(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  targets: readonly ScheduledWorkTarget[]
): boolean {
  const sql = requiredScheduledWorkTableSql(storage);
  ensureScheduledWorkSchema(sql);
  return targets.some(
    (target) => matchingScheduledWorkRows(sql, prefix, target).length > 0
  );
}

function matchingScheduledWorkRows(
  sql: SqlStorage,
  prefix: string,
  target: ScheduledWorkTarget
): ScheduledWorkRow[] {
  const rows = sql
    .exec<ScheduledWorkRow>(
      "SELECT work_id, payload FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
      prefix,
      target.kind,
      target.workId
    )
    .toArray();
  const matches = target.matchesPayload;
  return matches === undefined
    ? rows
    : rows.filter((row) => matches(row.payload));
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
    "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    prefix,
    kind,
    workId,
    JSON.stringify(payload),
    indexes.threadKey ?? null,
    indexes.runId ?? null,
    Date.now()
  );
}

function claimScheduledWorkRow(
  storage: CloudflareDurableObjectTransactionStorage,
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

function ensureScheduledWorkSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_scheduled_work (prefix TEXT NOT NULL, kind TEXT NOT NULL, work_id TEXT NOT NULL, payload TEXT NOT NULL, thread_key TEXT, run_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (prefix, kind, work_id))"
  );
  ensureScheduledWorkColumn(sql, "thread_key");
  ensureScheduledWorkColumn(sql, "run_id");
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_due ON pss_scheduled_work (prefix, kind, created_at, work_id)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_thread ON pss_scheduled_work (prefix, thread_key)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_run ON pss_scheduled_work (prefix, run_id)"
  );
}

function ensureScheduledWorkColumn(sql: SqlStorage, column: string): void {
  if (hasScheduledWorkColumn(sql, column)) {
    return;
  }
  sql.exec(`ALTER TABLE pss_scheduled_work ADD COLUMN ${column} TEXT`);
}

function requiredScheduledWorkTableSql(
  storage: CloudflareDurableObjectTransactionStorage
): SqlStorage {
  return requiredSqlStorage(storage, "Cloudflare scheduled work queue");
}
