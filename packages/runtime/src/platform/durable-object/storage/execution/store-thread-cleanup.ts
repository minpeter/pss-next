import type { SqlStorage } from "../../sql/ports/storage-port";
import { storeKey } from "./records";

export function deleteThreadRows(
  sql: SqlStorage,
  prefix: string,
  threadKey: string
): void {
  const threadRowKey = storeKey(prefix, "thread", threadKey);
  const threadEventKey = storeKey(prefix, "thread-events", threadKey);
  const runIds = selectThreadRunIds(sql, prefix, threadKey);
  const notificationKeys = selectThreadNotificationKeys(sql, prefix, threadKey);

  deleteThreadPayloadChunks(
    sql,
    prefix,
    threadKey,
    threadEventKey,
    runIds,
    notificationKeys
  );
  deleteRowsByKey(sql, threadRowKey, [
    ["pss_thread_message_chunk", "thread_key"],
    ["pss_thread_message", "thread_key"],
    ["pss_thread_compaction", "thread_key"],
    ["pss_thread_meta", "thread_key"],
  ]);
  deleteRowsByKey(sql, threadEventKey, [
    ["pss_thread_event", "thread_key"],
    ["pss_thread_event_meta", "thread_key"],
  ]);
  deleteRunRows(sql, prefix, runIds);
  deleteDirectThreadRows(sql, prefix, threadKey, runIds);
}

function selectThreadRunIds(
  sql: SqlStorage,
  prefix: string,
  threadKey: string
): string[] {
  if (!hasTable(sql, "pss_run")) {
    return [];
  }
  return sql
    .exec<{ readonly run_id: string }>(
      "SELECT run_id FROM pss_run WHERE prefix = ? AND thread_key = ?",
      prefix,
      threadKey
    )
    .toArray()
    .map((row) => row.run_id);
}

function selectThreadNotificationKeys(
  sql: SqlStorage,
  prefix: string,
  threadKey: string
): string[] {
  if (!hasTable(sql, "pss_notification")) {
    return [];
  }
  return sql
    .exec<{ readonly idempotency_key: string }>(
      "SELECT idempotency_key FROM pss_notification WHERE prefix = ? AND thread_key = ?",
      prefix,
      threadKey
    )
    .toArray()
    .map((row) => row.idempotency_key);
}

function deleteThreadPayloadChunks(
  sql: SqlStorage,
  prefix: string,
  threadKey: string,
  threadEventKey: string,
  runIds: readonly string[],
  notificationKeys: readonly string[]
): void {
  if (!hasTable(sql, "pss_payload_chunk")) {
    return;
  }
  deletePayloadChunks(sql, "thread-input", `${prefix}:${threadKey}`);
  deletePayloadChunks(sql, "thread-event", threadEventKey);
  for (const runId of runIds) {
    deletePayloadChunks(sql, "event", storeKey(prefix, "events", runId));
    deletePayloadChunks(
      sql,
      "checkpoint",
      storeKey(prefix, "checkpoints", runId)
    );
  }
  for (const key of notificationKeys) {
    sql.exec(
      "DELETE FROM pss_payload_chunk WHERE scope = ? AND owner_key = ? AND payload_key = ?",
      "notification",
      prefix,
      key
    );
  }
}

function deletePayloadChunks(
  sql: SqlStorage,
  scope: string,
  ownerKey: string
): void {
  sql.exec(
    "DELETE FROM pss_payload_chunk WHERE scope = ? AND owner_key = ?",
    scope,
    ownerKey
  );
}

function deleteRowsByKey(
  sql: SqlStorage,
  key: string,
  tables: readonly (readonly [string, string])[]
): void {
  for (const [table, column] of tables) {
    if (hasTable(sql, table)) {
      sql.exec(`DELETE FROM ${table} WHERE ${column} = ?`, key);
    }
  }
}

function deleteRunRows(
  sql: SqlStorage,
  prefix: string,
  runIds: readonly string[]
): void {
  for (const runId of runIds) {
    deleteRowsByKey(sql, storeKey(prefix, "events", runId), [
      ["pss_event", "run_key"],
      ["pss_event_meta", "run_key"],
    ]);
    deleteRowsByKey(sql, storeKey(prefix, "checkpoints", runId), [
      ["pss_checkpoint", "run_key"],
    ]);
  }
}

function deleteDirectThreadRows(
  sql: SqlStorage,
  prefix: string,
  threadKey: string,
  runIds: readonly string[]
): void {
  if (hasTable(sql, "pss_scheduled_work")) {
    sql.exec(
      "DELETE FROM pss_scheduled_work WHERE prefix = ? AND thread_key = ?",
      prefix,
      threadKey
    );
    for (const runId of runIds) {
      sql.exec(
        "DELETE FROM pss_scheduled_work WHERE prefix = ? AND run_id = ?",
        prefix,
        runId
      );
    }
  }
  for (const table of ["pss_notification", "pss_thread_input", "pss_run"]) {
    if (hasTable(sql, table)) {
      sql.exec(
        `DELETE FROM ${table} WHERE prefix = ? AND thread_key = ?`,
        prefix,
        threadKey
      );
    }
  }
}

function hasTable(sql: SqlStorage, table: string): boolean {
  return sql.exec(`PRAGMA table_info(${table})`).toArray().length > 0;
}
