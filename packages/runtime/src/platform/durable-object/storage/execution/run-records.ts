import type { TurnRecord } from "../../../../execution";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { DurableObjectTransactionStorage } from "../durable-object/durable-object-storage";
import { requiredSqlStorage } from "../durable-object/sql-access";
import {
  assertJsonPayloadWithinBudget,
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";

interface RunRow {
  readonly record: string;
}

export function getRun(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  runId: string
): Promise<TurnRecord | null> {
  const row = selectRunRow(
    requiredSqlStorage(storage, "DurableObjectRunStore"),
    prefix,
    runId
  );
  return Promise.resolve(row ? parseRunRecord(row) : null);
}

export function getRunByDedupeKey(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  dedupeKey: string
): Promise<TurnRecord | null> {
  const sql = requiredSqlStorage(storage, "DurableObjectRunStore");
  ensureRunSchema(sql);
  const row = sql
    .exec<RunRow>(
      "SELECT record FROM pss_run WHERE prefix = ? AND dedupe_key = ? LIMIT 1",
      prefix,
      dedupeKey
    )
    .toArray()[0];
  return Promise.resolve(row ? parseRunRecord(row) : null);
}

export function listRunsByParentRunId(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  parentRunId: string
): Promise<readonly TurnRecord[]> {
  const sql = requiredSqlStorage(storage, "DurableObjectRunStore");
  ensureRunSchema(sql);
  return Promise.resolve(
    sql
      .exec<RunRow>(
        "SELECT record FROM pss_run WHERE prefix = ? AND parent_run_id = ? ORDER BY created_at, rowid",
        prefix,
        parentRunId
      )
      .toArray()
      .map(parseRunRecord)
  );
}

export function putRun(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  record: TurnRecord,
  options: StoragePayloadBudgetOptions = {}
): Promise<void> {
  assertJsonPayloadWithinBudget(
    "run-record",
    record,
    resolveStoragePayloadMaxBytes(options)
  );
  putSqlRun(
    requiredSqlStorage(storage, "DurableObjectRunStore"),
    prefix,
    record
  );
  return Promise.resolve();
}

export function insertRun(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  record: TurnRecord,
  options: StoragePayloadBudgetOptions = {}
): Promise<void> {
  assertJsonPayloadWithinBudget(
    "run-record",
    record,
    resolveStoragePayloadMaxBytes(options)
  );
  insertSqlRun(
    requiredSqlStorage(storage, "DurableObjectRunStore"),
    prefix,
    record
  );
  return Promise.resolve();
}

function selectRunRow(
  sql: SqlStorage,
  prefix: string,
  runId: string
): RunRow | undefined {
  ensureRunSchema(sql);
  return sql
    .exec<RunRow>(
      "SELECT record FROM pss_run WHERE prefix = ? AND run_id = ?",
      prefix,
      runId
    )
    .toArray()[0];
}

function parseRunRecord(row: RunRow): TurnRecord {
  return JSON.parse(row.record) as TurnRecord;
}

function ensureRunSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_run (prefix TEXT NOT NULL, run_id TEXT NOT NULL, record TEXT NOT NULL, dedupe_key TEXT, parent_run_id TEXT, root_run_id TEXT NOT NULL, thread_key TEXT NOT NULL, status TEXT NOT NULL, checkpoint_version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (prefix, run_id))"
  );
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS pss_run_dedupe_unique ON pss_run (prefix, dedupe_key) WHERE dedupe_key IS NOT NULL"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_run_parent ON pss_run (prefix, parent_run_id, created_at)"
  );
}

function putSqlRun(sql: SqlStorage, prefix: string, record: TurnRecord): void {
  ensureRunSchema(sql);
  const nowMs = Date.now();
  sql.exec(
    "INSERT INTO pss_run (prefix, run_id, record, dedupe_key, parent_run_id, root_run_id, thread_key, status, checkpoint_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(prefix, run_id) DO UPDATE SET record = excluded.record, dedupe_key = excluded.dedupe_key, parent_run_id = excluded.parent_run_id, root_run_id = excluded.root_run_id, thread_key = excluded.thread_key, status = excluded.status, checkpoint_version = excluded.checkpoint_version, updated_at = excluded.updated_at",
    prefix,
    record.runId,
    JSON.stringify(record),
    record.dedupeKey ?? null,
    record.parentRunId ?? null,
    record.rootRunId,
    record.threadKey,
    record.status,
    record.checkpointVersion,
    nowMs,
    nowMs
  );
}

function insertSqlRun(
  sql: SqlStorage,
  prefix: string,
  record: TurnRecord
): void {
  ensureRunSchema(sql);
  const nowMs = Date.now();
  sql.exec(
    "INSERT INTO pss_run (prefix, run_id, record, dedupe_key, parent_run_id, root_run_id, thread_key, status, checkpoint_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    prefix,
    record.runId,
    JSON.stringify(record),
    record.dedupeKey ?? null,
    record.parentRunId ?? null,
    record.rootRunId,
    record.threadKey,
    record.status,
    record.checkpointVersion,
    nowMs,
    nowMs
  );
}
