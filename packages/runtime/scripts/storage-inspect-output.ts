import type { SqlStorage } from "../src/platform/cloudflare/sql/ports/storage-port";
import {
  collectStorageMetrics,
  type StorageLatencyTiming,
  summarizeStorageLatencyTimings,
} from "../src/platform/cloudflare/storage/execution/storage-metrics";

type TableName =
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

interface CountRow {
  readonly count: number;
}

interface SampleQuery {
  readonly label: TableName;
  readonly query: string;
}

const tables: readonly TableName[] = [
  "pss_thread_meta",
  "pss_thread_message",
  "pss_thread_message_chunk",
  "pss_run",
  "pss_event",
  "pss_event_meta",
  "pss_checkpoint",
  "pss_notification",
  "pss_thread_input",
  "pss_payload_chunk",
  "pss_scheduled_work",
];

const sampleQueries: readonly SampleQuery[] = [
  {
    label: "pss_thread_meta",
    query:
      "SELECT thread_key, version, message_count, state_blob IS NOT NULL AS has_state_blob FROM pss_thread_meta",
  },
  {
    label: "pss_thread_message",
    query:
      "SELECT thread_key, seq, active, substr(message, 1, 120) AS message_preview FROM pss_thread_message ORDER BY seq",
  },
  {
    label: "pss_thread_message_chunk",
    query:
      "SELECT thread_key, seq, chunk_index, length(chunk) AS chunk_chars FROM pss_thread_message_chunk ORDER BY seq, chunk_index",
  },
  {
    label: "pss_run",
    query:
      "SELECT run_id, thread_key, status, checkpoint_version, substr(record, 1, 140) AS record_preview FROM pss_run",
  },
  {
    label: "pss_event",
    query:
      "SELECT run_key, seq, substr(event, 1, 140) AS event_preview FROM pss_event ORDER BY seq",
  },
  {
    label: "pss_event_meta",
    query: "SELECT run_key, next_seq FROM pss_event_meta",
  },
  {
    label: "pss_checkpoint",
    query:
      "SELECT run_key, version, substr(checkpoint, 1, 180) AS checkpoint_preview FROM pss_checkpoint",
  },
  {
    label: "pss_notification",
    query:
      "SELECT idempotency_key, notification_id, run_id, thread_key, status, substr(record, 1, 140) AS record_preview FROM pss_notification",
  },
  {
    label: "pss_thread_input",
    query:
      "SELECT thread_key, message_id, kind, placement, status, admitted_seq, claim_id, substr(record, 1, 140) AS record_preview FROM pss_thread_input ORDER BY admitted_seq, message_id",
  },
  {
    label: "pss_payload_chunk",
    query:
      "SELECT scope, owner_key, payload_key, chunk_index, length(chunk) AS chunk_chars FROM pss_payload_chunk ORDER BY scope, owner_key, payload_key, chunk_index",
  },
  {
    label: "pss_scheduled_work",
    query:
      "SELECT kind, work_id, run_id, thread_key, substr(payload, 1, 140) AS payload_preview FROM pss_scheduled_work ORDER BY kind, work_id",
  },
];

export function printApiMap(): void {
  printSection("API -> SQL table map");
  const lines = [
    "threads.commit/load -> pss_thread_meta + pss_thread_message + pss_thread_message_chunk",
    "store.deleteThread -> all runtime-owned thread, run, event, checkpoint, notification, input, scheduled-work, and payload-chunk rows",
    "turns.create/get/update -> pss_run",
    "events.append/read -> pss_event + pss_event_meta",
    "checkpoints.append/latest -> pss_checkpoint + pss_run.checkpoint_version",
    "notifications.enqueue/claim -> pss_notification",
    "inputs.admit/claim/promote/ack -> pss_thread_input + pss_payload_chunk(scope=thread-input)",
    "scheduler.enqueueRun/resumeThread -> pss_scheduled_work",
  ];
  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

export function printTableCounts(runtimeSql: SqlStorage): void {
  printSection("Table counts");
  for (const table of tables) {
    const row = runtimeSql
      .exec<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`)
      .toArray()[0];
    console.log(`${table.padEnd(28)} ${row?.count ?? 0}`);
  }
}

export function printStorageMetrics(runtimeSql: SqlStorage): void {
  printSection("Storage metrics");
  const metrics = collectStorageMetrics(runtimeSql);
  console.log(`chunkBytes.payload ${metrics.chunkBytes.payload}`);
  console.log(`chunkBytes.threadMessage ${metrics.chunkBytes.threadMessage}`);
  console.log(`chunkBytes.total ${metrics.chunkBytes.total}`);
  console.log(`scheduledBacklog.run ${metrics.scheduledBacklog.run}`);
  console.log(
    `scheduledBacklog.threadPrompt ${metrics.scheduledBacklog.threadPrompt}`
  );
  console.log(`scheduledBacklog.total ${metrics.scheduledBacklog.total}`);
}

export function printLatencySummary(
  timingRows: readonly StorageLatencyTiming[]
): void {
  printSection("Latency summary");
  const summary = summarizeStorageLatencyTimings(timingRows);
  console.log(`count ${summary.count}`);
  console.log(`p50Ms ${formatMs(summary.p50Ms)}`);
  console.log(`p95Ms ${formatMs(summary.p95Ms)}`);
  console.log(`maxMs ${formatMs(summary.maxMs)}`);
  for (const timing of summary.byLabel) {
    console.log(`${timing.label} ${formatMs(timing.ms)}`);
  }
}

export function printTableSamples(runtimeSql: SqlStorage): void {
  printSection("Table samples");
  for (const sample of sampleQueries) {
    const rows = runtimeSql
      .exec<Readonly<Record<string, unknown>>>(sample.query)
      .toArray();
    console.log(`\n[${sample.label}]`);
    for (const row of rows) {
      console.log(preview(row, 260));
    }
  }
}

export function preview(value: unknown, maxLength: number): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    return "undefined";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function printSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function formatMs(ms: number): string {
  return ms.toFixed(3);
}
