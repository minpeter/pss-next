import type { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";

export function countRows(
  sql: InMemorySqlStorage,
  table: StorageStressTable
): number {
  const [row] = sql
    .exec<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`)
    .toArray();
  return row?.count ?? 0;
}

export function sumChunkBytes(sql: InMemorySqlStorage): number {
  return (
    sumTextBytes(sql, "pss_payload_chunk", "chunk") +
    sumTextBytes(sql, "pss_thread_message_chunk", "chunk")
  );
}

export type StorageStressTable =
  | "pss_checkpoint"
  | "pss_event"
  | "pss_notification"
  | "pss_payload_chunk"
  | "pss_run"
  | "pss_scheduled_work"
  | "pss_thread_message"
  | "pss_thread_message_chunk"
  | "pss_thread_meta";

interface CountRow {
  readonly count: number;
}

function sumTextBytes(
  sql: InMemorySqlStorage,
  table: "pss_payload_chunk" | "pss_thread_message_chunk",
  column: "chunk"
): number {
  const [row] = sql
    .exec<{ bytes: number }>(
      `SELECT COALESCE(SUM(LENGTH(${column})), 0) AS bytes FROM ${table}`
    )
    .toArray();
  return row?.bytes ?? 0;
}
