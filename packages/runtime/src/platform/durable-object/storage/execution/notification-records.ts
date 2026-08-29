import type { NotificationRecord } from "../../../../execution";
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

interface NotificationRow {
  readonly record: string;
}

export function getNotification(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  idempotencyKey: string
): Promise<NotificationRecord | null> {
  const sql = requiredSqlStorage(storage, "DurableObjectNotificationInbox");
  const row = selectNotificationRow(sql, prefix, idempotencyKey);
  return Promise.resolve(
    row ? parseStoredNotificationRecord(sql, prefix, idempotencyKey, row) : null
  );
}

export function putNotification(
  storage: DurableObjectTransactionStorage,
  prefix: string,
  record: NotificationRecord,
  options: StoragePayloadBudgetOptions = {}
): Promise<void> {
  putSqlNotification(
    requiredSqlStorage(storage, "DurableObjectNotificationInbox"),
    prefix,
    record,
    resolveStoragePayloadMaxBytes(options)
  );
  return Promise.resolve();
}

function selectNotificationRow(
  sql: SqlStorage,
  prefix: string,
  idempotencyKey: string
): NotificationRow | undefined {
  ensureNotificationSchema(sql);
  return sql
    .exec<NotificationRow>(
      "SELECT record FROM pss_notification WHERE prefix = ? AND idempotency_key = ? LIMIT 1",
      prefix,
      idempotencyKey
    )
    .toArray()[0];
}

function ensureNotificationSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_notification (prefix TEXT NOT NULL, idempotency_key TEXT NOT NULL, record TEXT NOT NULL, notification_id TEXT NOT NULL, run_id TEXT NOT NULL, thread_key TEXT NOT NULL, owner_namespace TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (prefix, idempotency_key))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_notification_status ON pss_notification (prefix, status, created_at)"
  );
  ensurePayloadChunkSchema(sql);
}

function putSqlNotification(
  sql: SqlStorage,
  prefix: string,
  record: NotificationRecord,
  maxPayloadBytes: number
): void {
  ensureNotificationSchema(sql);
  const nowMs = Date.now();
  const serializedRecord = writeJsonPayloadToSqlRows(
    sql,
    notificationPayloadLocation(prefix, record.idempotencyKey),
    "notification-record",
    record,
    maxPayloadBytes
  );
  sql.exec(
    "INSERT INTO pss_notification (prefix, idempotency_key, record, notification_id, run_id, thread_key, owner_namespace, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(prefix, idempotency_key) DO UPDATE SET record = excluded.record, notification_id = excluded.notification_id, run_id = excluded.run_id, thread_key = excluded.thread_key, owner_namespace = excluded.owner_namespace, status = excluded.status, updated_at = excluded.updated_at",
    prefix,
    record.idempotencyKey,
    serializedRecord,
    record.notificationId,
    record.runId,
    record.threadKey,
    record.ownerNamespace ?? null,
    record.status,
    nowMs,
    nowMs
  );
}

function parseStoredNotificationRecord(
  sql: SqlStorage,
  prefix: string,
  idempotencyKey: string,
  row: NotificationRow
): NotificationRecord {
  const record = readJsonPayloadFromSqlRows(
    sql,
    notificationPayloadLocation(prefix, idempotencyKey),
    row.record
  );
  return JSON.parse(record) as NotificationRecord;
}

function notificationPayloadLocation(prefix: string, idempotencyKey: string) {
  return {
    ownerKey: prefix,
    payloadKey: idempotencyKey,
    scope: "notification",
  };
}
