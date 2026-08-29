import type { SqlStorage } from "../../sql/ports/storage-port";

const textEncoder = new TextEncoder();

export type StorageMetricsTable =
  | "pss_checkpoint"
  | "pss_event"
  | "pss_event_meta"
  | "pss_notification"
  | "pss_payload_chunk"
  | "pss_run"
  | "pss_scheduled_work"
  | "pss_thread_input"
  | "pss_thread_message"
  | "pss_thread_message_chunk"
  | "pss_thread_meta";

export interface StorageMetrics {
  readonly chunkBytes: {
    readonly payload: number;
    readonly threadMessage: number;
    readonly total: number;
  };
  readonly rowCounts: Readonly<Record<StorageMetricsTable, number>>;
  readonly scheduledBacklog: {
    readonly run: number;
    readonly threadPrompt: number;
    readonly total: number;
  };
}

export interface StorageLatencyTiming {
  readonly label: string;
  readonly ms: number;
}

export interface StorageLatencySummary {
  readonly byLabel: readonly StorageLatencyTiming[];
  readonly count: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export function collectStorageMetrics(sql: SqlStorage): StorageMetrics {
  const rowCounts: Readonly<Record<StorageMetricsTable, number>> = {
    pss_checkpoint: countRows(sql, "pss_checkpoint"),
    pss_event: countRows(sql, "pss_event"),
    pss_event_meta: countRows(sql, "pss_event_meta"),
    pss_notification: countRows(sql, "pss_notification"),
    pss_payload_chunk: countRows(sql, "pss_payload_chunk"),
    pss_run: countRows(sql, "pss_run"),
    pss_scheduled_work: countRows(sql, "pss_scheduled_work"),
    pss_thread_input: countRows(sql, "pss_thread_input"),
    pss_thread_message: countRows(sql, "pss_thread_message"),
    pss_thread_message_chunk: countRows(sql, "pss_thread_message_chunk"),
    pss_thread_meta: countRows(sql, "pss_thread_meta"),
  };
  const payloadChunkBytes = sumTextBytes(sql, "pss_payload_chunk", "chunk");
  const threadMessageChunkBytes = sumTextBytes(
    sql,
    "pss_thread_message_chunk",
    "chunk"
  );
  const runBacklog = countScheduledBacklog(sql, "run");
  const threadPromptBacklog = countScheduledBacklog(sql, "thread-prompt");

  return {
    chunkBytes: {
      payload: payloadChunkBytes,
      threadMessage: threadMessageChunkBytes,
      total: payloadChunkBytes + threadMessageChunkBytes,
    },
    rowCounts,
    scheduledBacklog: {
      run: runBacklog,
      threadPrompt: threadPromptBacklog,
      total: runBacklog + threadPromptBacklog,
    },
  };
}

export function summarizeStorageLatencyTimings(
  timings: readonly StorageLatencyTiming[]
): StorageLatencySummary {
  const sorted = [...timings].sort((left, right) => left.ms - right.ms);
  return {
    byLabel: [...timings],
    count: timings.length,
    maxMs: sorted.at(-1)?.ms ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function countRows(sql: SqlStorage, table: StorageMetricsTable): number {
  const [row] = sql
    .exec<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
    .toArray();
  return row?.count ?? 0;
}

function countScheduledBacklog(
  sql: SqlStorage,
  kind: "run" | "thread-prompt"
): number {
  const [row] = sql
    .exec<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM pss_scheduled_work WHERE kind = ?",
      kind
    )
    .toArray();
  return row?.count ?? 0;
}

function sumTextBytes(
  sql: SqlStorage,
  table: "pss_payload_chunk" | "pss_thread_message_chunk",
  column: "chunk"
): number {
  const rows = sql
    .exec<{ readonly chunk: string }>(`SELECT ${column} AS chunk FROM ${table}`)
    .toArray();
  return rows.reduce((total, row) => total + utf8ByteLength(row.chunk), 0);
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function percentile(
  sorted: readonly StorageLatencyTiming[],
  quantile: number
): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index]?.ms ?? 0;
}
