import { numberBinding, stringBinding } from "./bindings";
import type {
  CheckpointRow,
  EventRow,
  InMemoryDurableObjectSqlState,
  NotificationRow,
  PayloadChunkRow,
  RunRow,
  ThreadEventRow,
} from "./state";
import { selectThreadSqlRows } from "./thread-select";

export function selectSqlRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  if (query.includes("from sqlite_master")) {
    return [];
  }
  if (query.includes("from pss_thread_event_meta")) {
    return selectThreadEventMetaRows(state, bindings);
  }
  if (query.includes("from pss_thread_event")) {
    return selectThreadEventRows(state, query, bindings);
  }
  if (query.includes("from pss_thread_")) {
    return selectThreadSqlRows(state, query, bindings);
  }
  if (query.includes("from pss_run")) {
    return selectRunRows(state, query, bindings);
  }
  if (query.includes("from pss_notification")) {
    return selectNotificationRows(state, query, bindings);
  }
  if (query.includes("from pss_payload_chunk")) {
    return selectPayloadChunkRows(state, query, bindings);
  }
  if (query.includes("from pss_event_meta")) {
    return selectEventMetaRows(state, bindings);
  }
  if (query.includes("from pss_event")) {
    return selectEventRows(state, query, bindings);
  }
  if (query.includes("from pss_checkpoint")) {
    return selectCheckpointRows(state, query, bindings);
  }
  throw new Error(`Unsupported in-memory Durable Object SQL query: ${query}`);
}

function selectPayloadChunkRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const scope = stringBinding(bindings[0]);
  const ownerKey = stringBinding(bindings[1]);
  const payloadKeys = query.includes("payload_key in")
    ? new Set(bindings.slice(2).map(stringBinding))
    : new Set([stringBinding(bindings[2])]);
  return state.payloadChunks
    .filter(
      (row) =>
        row.scope === scope &&
        row.owner_key === ownerKey &&
        payloadKeys.has(row.payload_key)
    )
    .sort(
      (left: PayloadChunkRow, right: PayloadChunkRow) =>
        left.payload_key.localeCompare(right.payload_key) ||
        left.chunk_index - right.chunk_index
    )
    .map((row) => projectPayloadChunk(row, query));
}

function selectRunRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const prefix = stringBinding(bindings[0]);
  if (query.includes("thread_key = ?")) {
    const threadKey = stringBinding(bindings[1]);
    return state.turns
      .filter((row) => row.prefix === prefix && row.thread_key === threadKey)
      .map((row) => ({ run_id: row.run_id }));
  }
  if (query.includes("run_id = ?")) {
    const runId = stringBinding(bindings[1]);
    return state.turns
      .filter((row) => row.prefix === prefix && row.run_id === runId)
      .map(projectRun);
  }
  if (query.includes("dedupe_key = ?")) {
    const dedupeKey = stringBinding(bindings[1]);
    return state.turns
      .filter((row) => row.prefix === prefix && row.dedupe_key === dedupeKey)
      .map(projectRun)
      .slice(0, 1);
  }
  if (query.includes("parent_run_id = ?")) {
    const parentRunId = stringBinding(bindings[1]);
    return state.turns
      .filter(
        (row) => row.prefix === prefix && row.parent_run_id === parentRunId
      )
      .sort((left: RunRow, right: RunRow) => left.created_at - right.created_at)
      .map(projectRun);
  }
  throw new Error(`Unsupported in-memory run SQL query: ${query}`);
}

function selectNotificationRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const prefix = stringBinding(bindings[0]);
  if (query.includes("thread_key = ?")) {
    const threadKey = stringBinding(bindings[1]);
    return state.notifications
      .filter((row) => row.prefix === prefix && row.thread_key === threadKey)
      .map((row) => ({ idempotency_key: row.idempotency_key }));
  }
  if (query.includes("idempotency_key = ?")) {
    const idempotencyKey = stringBinding(bindings[1]);
    return state.notifications
      .filter(
        (row) => row.prefix === prefix && row.idempotency_key === idempotencyKey
      )
      .map(projectNotification)
      .slice(0, 1);
  }
  throw new Error(`Unsupported in-memory notification SQL query: ${query}`);
}

function selectEventMetaRows(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const row = state.eventMeta.get(key);
  return row ? [{ next_seq: row.next_seq }] : [];
}

function selectEventRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const start = query.includes("seq >= ?") ? numberBinding(bindings[1]) : 0;
  return [...state.events]
    .filter((row) => row.run_key === key && row.seq >= start)
    .sort((left: EventRow, right: EventRow) => left.seq - right.seq)
    .map((row: EventRow) => ({ event: row.event, seq: row.seq }));
}

function selectThreadEventMetaRows(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const row = state.threadEventMeta.get(key);
  return row ? [{ next_seq: row.next_seq }] : [];
}

function selectThreadEventRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const start = query.includes("seq >= ?") ? numberBinding(bindings[1]) : 0;
  const limit = query.includes("limit ?")
    ? numberBinding(bindings[2])
    : undefined;
  return [...state.threadEvents]
    .filter((row) => row.thread_key === key && row.seq >= start)
    .sort((left: ThreadEventRow, right: ThreadEventRow) => left.seq - right.seq)
    .slice(0, limit)
    .map((row: ThreadEventRow) => ({ event: row.event, seq: row.seq }));
}

function selectCheckpointRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const rows = state.checkpoints.filter((row) => row.run_key === key);
  if (query.includes("order by version desc limit 1")) {
    const latest = [...rows].sort(
      (left: CheckpointRow, right: CheckpointRow) =>
        right.version - left.version
    )[0];
    return latest
      ? [{ checkpoint: latest.checkpoint, version: latest.version }]
      : [];
  }
  return [...rows]
    .sort(
      (left: CheckpointRow, right: CheckpointRow) =>
        left.version - right.version
    )
    .map((row: CheckpointRow) => ({
      checkpoint: row.checkpoint,
      version: row.version,
    }));
}

function projectRun(row: RunRow): unknown {
  return { record: row.record };
}

function projectNotification(row: NotificationRow): unknown {
  return { record: row.record };
}

function projectPayloadChunk(row: PayloadChunkRow, query: string): unknown {
  const projected: Record<string, unknown> = {
    chunk: row.chunk,
    chunk_index: row.chunk_index,
  };
  if (query.includes("payload_key")) {
    projected.payload_key = row.payload_key;
  }
  return projected;
}
