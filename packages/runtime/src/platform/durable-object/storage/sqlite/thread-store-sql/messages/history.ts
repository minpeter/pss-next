import type { SqlStorage } from "../../../../sql/ports/storage-port";
import type {
  RawThreadMessageRow,
  ThreadMessageChunkMarker,
  ThreadMessageRow,
  WriteHistoryRowsOptions,
} from "../keys/types";
import {
  parseThreadMessageChunkMarker,
  rawThreadMessageEquals,
  readThreadMessageChunks,
  reconstructThreadMessagePayload,
  stringifyThreadMessagePayload,
} from "./chunks";

export function readActiveThreadMessages(
  sql: SqlStorage,
  key: string
): ThreadMessageRow[] {
  const rows = sql
    .exec<ThreadMessageRow>(
      "SELECT seq, message FROM pss_thread_message WHERE thread_key = ? AND active = 1 ORDER BY seq",
      key
    )
    .toArray();
  const chunkMarkers = new Map<number, ThreadMessageChunkMarker>();
  for (const row of rows) {
    const marker = parseThreadMessageChunkMarker(row.message);
    if (marker) {
      chunkMarkers.set(row.seq, marker);
    }
  }
  if (chunkMarkers.size === 0) {
    return rows;
  }
  const chunks = readThreadMessageChunks(sql, key, [...chunkMarkers.keys()]);
  return rows.map((row) => {
    const marker = chunkMarkers.get(row.seq);
    if (!marker) {
      return row;
    }
    return {
      ...row,
      message: reconstructThreadMessagePayload(
        key,
        row,
        marker,
        chunks.get(row.seq) ?? []
      ),
    };
  });
}

export function writeThreadHistoryRows(
  options: WriteHistoryRowsOptions
): number {
  const { history, key, maxPayloadBytes, meta, nextSeqStart, sql } = options;
  if (
    meta?.state_blob === null &&
    history.length > meta.message_count &&
    meta.next_seq === nextSeqStart
  ) {
    return insertThreadMessages({
      history: history.slice(meta.message_count),
      key,
      maxPayloadBytes,
      seq: nextSeqStart,
      sql,
    });
  }

  const existing = readRawActiveThreadMessages(sql, key);
  let prefix = 0;
  while (prefix < existing.length && prefix < history.length) {
    const existingMessage = existing[prefix];
    const historyMessage = history[prefix];
    if (
      existingMessage === undefined ||
      historyMessage === undefined ||
      !rawThreadMessageEquals(sql, key, existingMessage, historyMessage)
    ) {
      break;
    }
    prefix += 1;
  }
  const firstStaleMessage = existing[prefix];
  if (firstStaleMessage !== undefined) {
    sql.exec(
      "UPDATE pss_thread_message SET active = 0 WHERE thread_key = ? AND active = 1 AND seq >= ?",
      key,
      firstStaleMessage.seq
    );
  }
  return insertThreadMessages({
    history: history.slice(prefix),
    key,
    maxPayloadBytes,
    seq: nextSeqStart,
    sql,
  });
}

export function softDeleteActiveThreadRows(sql: SqlStorage, key: string): void {
  sql.exec(
    "UPDATE pss_thread_message SET active = 0 WHERE thread_key = ? AND active = 1",
    key
  );
}

export function insertThreadMessages({
  history,
  key,
  maxPayloadBytes,
  seq,
  sql,
}: {
  readonly history: readonly unknown[];
  readonly key: string;
  readonly maxPayloadBytes: number;
  readonly seq: number;
  readonly sql: SqlStorage;
}): number {
  let nextSeq = seq;
  for (const value of history) {
    const message = stringifyThreadMessagePayload(
      sql,
      key,
      nextSeq,
      value,
      maxPayloadBytes
    );
    sql.exec(
      "INSERT INTO pss_thread_message (thread_key, seq, active, message) VALUES (?, ?, 1, ?)",
      key,
      nextSeq,
      message
    );
    nextSeq += 1;
  }
  return nextSeq;
}

function readRawActiveThreadMessages(
  sql: SqlStorage,
  key: string
): RawThreadMessageRow[] {
  return sql
    .exec<RawThreadMessageRow>(
      "SELECT seq, message FROM pss_thread_message WHERE thread_key = ? AND active = 1 ORDER BY seq",
      key
    )
    .toArray();
}
