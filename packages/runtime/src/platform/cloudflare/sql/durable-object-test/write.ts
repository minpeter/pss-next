import {
  nullableStringBinding,
  numberBinding,
  stringBinding,
} from "./bindings";
import { writeNotificationStatement } from "./notification-write";
import { writeRunStatement } from "./run-write";
import type { InMemoryDurableObjectSqlState, PayloadChunkRow } from "./state";
import { writeThreadStatement } from "./thread-write";

export function writeSqlStatement(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  if (query.startsWith("insert into pss_thread_event_meta")) {
    writeThreadEventMeta(state, bindings);
    return;
  }
  if (query.startsWith("insert into pss_thread_event")) {
    writeThreadEvent(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_thread_event_meta")) {
    state.threadEventMeta.delete(stringBinding(bindings[0]));
    return;
  }
  if (query.startsWith("delete from pss_thread_event")) {
    const key = stringBinding(bindings[0]);
    state.threadEvents = state.threadEvents.filter(
      (row) => row.thread_key !== key
    );
    return;
  }
  if (query.includes("pss_thread_")) {
    writeThreadStatement(state, query, bindings);
    return;
  }
  if (writeRunStatement(state, query, bindings)) {
    return;
  }
  if (writeNotificationStatement(state, query, bindings)) {
    return;
  }
  if (query.startsWith("insert into pss_payload_chunk")) {
    insertPayloadChunk(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_payload_chunk")) {
    deletePayloadChunks(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_event_meta")) {
    state.eventMeta.delete(stringBinding(bindings[0]));
    return;
  }
  if (query.startsWith("delete from pss_event")) {
    const key = stringBinding(bindings[0]);
    state.events = state.events.filter((row) => row.run_key !== key);
    return;
  }
  if (query.startsWith("delete from pss_checkpoint")) {
    const key = stringBinding(bindings[0]);
    state.checkpoints = state.checkpoints.filter((row) => row.run_key !== key);
    return;
  }
  if (query.startsWith("insert into pss_event_meta")) {
    writeEventMeta(state, bindings);
    return;
  }
  if (query.startsWith("insert into pss_event")) {
    writeEvent(state, bindings);
    return;
  }
  if (query.startsWith("insert into pss_checkpoint")) {
    writeCheckpoint(state, bindings);
    return;
  }
  if (query.startsWith("insert into pss_scheduled_work")) {
    writeScheduledWork(state, bindings);
    return;
  }
  if (query.startsWith("update pss_scheduled_work set claim_token = null")) {
    releaseScheduledWork(state, bindings);
    return;
  }
  if (query.startsWith("update pss_scheduled_work set claim_token")) {
    claimScheduledWork(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_scheduled_work")) {
    deleteScheduledWork(state, query, bindings);
    return;
  }
  throw new Error(
    `Unsupported in-memory Durable Object SQL statement: ${query}`
  );
}

function insertPayloadChunk(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const row: PayloadChunkRow = {
    chunk: stringBinding(bindings[4]),
    chunk_index: numberBinding(bindings[3]),
    owner_key: stringBinding(bindings[1]),
    payload_key: stringBinding(bindings[2]),
    scope: stringBinding(bindings[0]),
  };
  state.payloadChunks = state.payloadChunks.filter(
    (existing) =>
      !(
        existing.scope === row.scope &&
        existing.owner_key === row.owner_key &&
        existing.payload_key === row.payload_key &&
        existing.chunk_index === row.chunk_index
      )
  );
  state.payloadChunks.push(row);
}

function deletePayloadChunks(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const scope = stringBinding(bindings[0]);
  const ownerKey = stringBinding(bindings[1]);
  const payloadKey =
    bindings.length > 2 ? stringBinding(bindings[2]) : undefined;
  state.payloadChunks = state.payloadChunks.filter(
    (row) =>
      !(
        row.scope === scope &&
        row.owner_key === ownerKey &&
        (payloadKey === undefined || row.payload_key === payloadKey)
      )
  );
}

function writeEventMeta(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.eventMeta.set(key, {
    next_seq: numberBinding(bindings[1]),
    run_key: key,
  });
}

function writeEvent(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  state.events.push({
    event: stringBinding(bindings[2]),
    run_key: stringBinding(bindings[0]),
    seq: numberBinding(bindings[1]),
  });
}

function writeThreadEventMeta(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.threadEventMeta.set(key, {
    next_seq: numberBinding(bindings[1]),
    thread_key: key,
  });
}

function writeThreadEvent(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  state.threadEvents.push({
    event: stringBinding(bindings[2]),
    seq: numberBinding(bindings[1]),
    thread_key: stringBinding(bindings[0]),
  });
}

function writeCheckpoint(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const runKey = stringBinding(bindings[0]);
  const version = numberBinding(bindings[1]);
  state.checkpoints = state.checkpoints.filter(
    (row) => !(row.run_key === runKey && row.version === version)
  );
  state.checkpoints.push({
    checkpoint: stringBinding(bindings[2]),
    run_key: runKey,
    version,
  });
}

function writeScheduledWork(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[0]);
  const kind = stringBinding(bindings[1]);
  const workId = stringBinding(bindings[2]);
  state.scheduledWork = state.scheduledWork.filter(
    (row) =>
      !(row.prefix === prefix && row.kind === kind && row.work_id === workId)
  );
  state.scheduledWork.push({
    claimed_until: null,
    claim_token: null,
    created_at: numberBinding(bindings[6]),
    kind,
    payload: stringBinding(bindings[3]),
    prefix,
    run_id: nullableStringBinding(bindings[5]),
    thread_key: nullableStringBinding(bindings[4]),
    work_id: workId,
  });
}

function claimScheduledWork(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const token = stringBinding(bindings[0]);
  const claimedUntil = numberBinding(bindings[1]);
  const prefix = stringBinding(bindings[2]);
  const kind = stringBinding(bindings[3]);
  const workId = stringBinding(bindings[4]);
  const nowMs = numberBinding(bindings[5]);
  const row = state.scheduledWork.find(
    (candidate) =>
      candidate.prefix === prefix &&
      candidate.kind === kind &&
      candidate.work_id === workId &&
      (candidate.claimed_until === null || candidate.claimed_until <= nowMs)
  );
  if (row !== undefined) {
    row.claim_token = token;
    row.claimed_until = claimedUntil;
  }
}

function releaseScheduledWork(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const payload = stringBinding(bindings[0]);
  const createdAt = numberBinding(bindings[1]);
  const prefix = stringBinding(bindings[2]);
  const kind = stringBinding(bindings[3]);
  const workId = stringBinding(bindings[4]);
  const token = stringBinding(bindings[5]);
  const row = state.scheduledWork.find(
    (candidate) =>
      candidate.prefix === prefix &&
      candidate.kind === kind &&
      candidate.work_id === workId &&
      candidate.claim_token === token
  );
  if (row !== undefined) {
    row.claim_token = null;
    row.claimed_until = null;
    row.created_at = createdAt;
    row.payload = payload;
  }
}

function deleteScheduledWork(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[0]);
  if (query.includes("payload like ?")) {
    const pattern = stringBinding(bindings[1]);
    state.scheduledWork = state.scheduledWork.filter(
      (row) =>
        !(row.prefix === prefix && sqliteLikeMatches(row.payload, pattern))
    );
    return;
  }
  if (query.includes("thread_key = ?")) {
    const threadKey = stringBinding(bindings[1]);
    state.scheduledWork = state.scheduledWork.filter(
      (row) => !(row.prefix === prefix && row.thread_key === threadKey)
    );
    return;
  }
  if (query.includes("run_id = ?")) {
    const runId = stringBinding(bindings[1]);
    state.scheduledWork = state.scheduledWork.filter(
      (row) => !(row.prefix === prefix && row.run_id === runId)
    );
    return;
  }
  const kind = stringBinding(bindings[1]);
  const workId = stringBinding(bindings[2]);
  const token =
    query.includes("claim_token = ?") && bindings.length > 3
      ? stringBinding(bindings[3])
      : undefined;
  state.scheduledWork = state.scheduledWork.filter(
    (row) =>
      !(
        row.prefix === prefix &&
        row.kind === kind &&
        row.work_id === workId &&
        (token === undefined || row.claim_token === token)
      )
  );
}

function sqliteLikeMatches(value: string, pattern: string): boolean {
  let source = "^";
  let escaping = false;
  for (const char of pattern) {
    if (escaping) {
      source += escapeRegExp(char);
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "%") {
      source += ".*";
      continue;
    }
    if (char === "_") {
      source += ".";
      continue;
    }
    source += escapeRegExp(char);
  }
  if (escaping) {
    source += "\\\\";
  }
  return new RegExp(`${source}$`, "s").test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
