import type { ThreadInputRecord } from "../../../../execution";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { DurableObjectTransactionStorage } from "../durable-object/durable-object-storage";
import { requiredSqlStorage } from "../durable-object/sql-access";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import { readJsonPayloadFromSqlRows } from "../sqlite/payload-chunk-read";
import { ensurePayloadChunkSchema } from "../sqlite/payload-chunk-table";
import { writeJsonPayloadToSqlRows } from "../sqlite/payload-chunk-write";
import {
  parseThreadInputRecord,
  StoredThreadInputRecordParseError,
} from "./input-record-parser";

interface ThreadInputRow {
  readonly message_id: string;
  readonly record: string;
}

export function listThreadInputRecords(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  threadKey: string
): Promise<readonly ThreadInputRecord[]> {
  const sql = requiredSqlStorage(storage, "DurableObjectThreadInputInbox");
  ensureThreadInputSchema(sql);
  const rows = sql
    .exec<ThreadInputRow>(
      "SELECT message_id, record FROM pss_thread_input WHERE prefix = ? AND thread_key = ? ORDER BY admitted_seq, message_id",
      prefix,
      threadKey
    )
    .toArray();
  return Promise.resolve(
    rows.map((row) => parseStoredThreadInputRecord(sql, prefix, threadKey, row))
  );
}

export function putThreadInputRecords(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  records: readonly ThreadInputRecord[],
  options: StoragePayloadBudgetOptions = {}
): Promise<void> {
  const sql = requiredSqlStorage(storage, "DurableObjectThreadInputInbox");
  ensureThreadInputSchema(sql);
  const maxPayloadBytes = resolveStoragePayloadMaxBytes(options);
  for (const record of records) {
    putThreadInputRecord(sql, prefix, record, maxPayloadBytes);
  }
  return Promise.resolve();
}

function ensureThreadInputSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_thread_input (prefix TEXT NOT NULL, thread_key TEXT NOT NULL, message_id TEXT NOT NULL, record TEXT NOT NULL, kind TEXT NOT NULL, placement TEXT, status TEXT NOT NULL, admitted_seq INTEGER NOT NULL, admitted_at_ms INTEGER NOT NULL, claim_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (prefix, thread_key, message_id))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_thread_input_pending ON pss_thread_input (prefix, thread_key, status, admitted_seq)"
  );
  ensurePayloadChunkSchema(sql);
}

function putThreadInputRecord(
  sql: SqlStorage,
  prefix: string,
  record: ThreadInputRecord,
  maxPayloadBytes: number
): void {
  const nowMs = Date.now();
  const serializedRecord = writeJsonPayloadToSqlRows(
    sql,
    threadInputPayloadLocation(prefix, record.threadKey, record.messageId),
    "thread-input",
    record,
    maxPayloadBytes
  );
  sql.exec(
    "INSERT INTO pss_thread_input (prefix, thread_key, message_id, record, kind, placement, status, admitted_seq, admitted_at_ms, claim_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(prefix, thread_key, message_id) DO UPDATE SET record = excluded.record, kind = excluded.kind, placement = excluded.placement, status = excluded.status, admitted_seq = excluded.admitted_seq, admitted_at_ms = excluded.admitted_at_ms, claim_id = excluded.claim_id, updated_at = excluded.updated_at",
    prefix,
    record.threadKey,
    record.messageId,
    serializedRecord,
    record.kind,
    record.placement ?? null,
    record.status,
    record.admittedSeq,
    record.admittedAtMs,
    record.claimId ?? null,
    nowMs,
    nowMs
  );
}

function parseStoredThreadInputRecord(
  sql: SqlStorage,
  prefix: string,
  threadKey: string,
  row: ThreadInputRow
): ThreadInputRecord {
  const storedPayload = readJsonPayloadFromSqlRows(
    sql,
    threadInputPayloadLocation(prefix, threadKey, row.message_id),
    row.record
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedPayload);
  } catch {
    throw new StoredThreadInputRecordParseError();
  }
  return parseThreadInputRecord(parsed);
}

function threadInputPayloadLocation(
  prefix: string,
  threadKey: string,
  messageId: string
) {
  return {
    ownerKey: `${prefix}:${threadKey}`,
    payloadKey: messageId,
    scope: "thread-input",
  };
}
