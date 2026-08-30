import type {
  StoredThreadEvent,
  ThreadEventCursor,
  ThreadEventLog,
  ThreadEventReadOptions,
} from "../../../../execution";
import {
  createThreadEventCursor,
  normalizeThreadEventReadOptions,
} from "../../../../execution/host/event-cursors";
import type { AgentEvent } from "../../../../thread/protocol/events";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { DurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import { readJsonPayloadsFromSqlRows } from "./payload-chunk-read";
import { ensurePayloadChunkSchema } from "./payload-chunk-table";
import { writeJsonPayloadToSqlRows } from "./payload-chunk-write";

interface ThreadEventRow {
  readonly event: string;
  readonly seq: number;
}

interface ThreadEventMetaRow {
  readonly next_seq: number;
}

export class DurableObjectSqliteThreadEventLog implements ThreadEventLog {
  readonly #maxPayloadBytes: number;
  readonly #prefix: string;
  readonly #sql: SqlStorage;
  #schemaReady = false;

  constructor(
    storage: DurableObjectStorage,
    prefix: string,
    options: StoragePayloadBudgetOptions = {}
  ) {
    const sql = storage.sql as SqlStorage | undefined;
    if (!sql) {
      throw new Error(
        "DurableObjectSqliteThreadEventLog requires a SQLite-backed Durable Object (storage.sql is unavailable)"
      );
    }
    this.#maxPayloadBytes = resolveStoragePayloadMaxBytes(options);
    this.#prefix = prefix;
    this.#sql = sql;
  }

  append(threadKey: string, event: AgentEvent): Promise<ThreadEventCursor> {
    return new Promise((resolve) => {
      this.#ensureSchema();
      const key = this.#rowKey(threadKey);
      const seq = this.#readNextSeq(key);
      const serializedEvent = writeJsonPayloadToSqlRows(
        this.#sql,
        this.#payloadLocation(key, seq),
        "thread-event",
        event,
        this.#maxPayloadBytes
      );
      this.#sql.exec(
        "INSERT INTO pss_thread_event (thread_key, seq, event) VALUES (?, ?, ?)",
        key,
        seq,
        serializedEvent
      );
      this.#writeNextSeq(key, seq + 1);
      resolve(createThreadEventCursor(seq + 1));
    });
  }

  async *read(
    threadKey: string,
    options: ThreadEventReadOptions = {}
  ): AsyncIterable<StoredThreadEvent> {
    await Promise.resolve();
    this.#ensureSchema();
    const key = this.#rowKey(threadKey);
    const { limit, start } = normalizeThreadEventReadOptions(options);
    const rows = this.#readRows(key, start, limit);
    const payloads = readJsonPayloadsFromSqlRows(
      this.#sql,
      "thread-event",
      key,
      rows.map((row) => ({
        payloadKey: String(row.seq),
        storedPayload: row.event,
      }))
    );
    for (const row of rows) {
      const event = payloads.get(String(row.seq));
      if (event === undefined) {
        throw new Error(
          `Missing thread event payload for ${key} seq ${row.seq}`
        );
      }
      yield {
        cursor: createThreadEventCursor(row.seq + 1),
        event: JSON.parse(event) as AgentEvent,
        threadKey,
      };
    }
  }

  #readRows(
    key: string,
    start: number,
    limit: number | undefined
  ): ThreadEventRow[] {
    if (limit === undefined) {
      return this.#sql
        .exec<ThreadEventRow>(
          "SELECT seq, event FROM pss_thread_event WHERE thread_key = ? AND seq >= ? ORDER BY seq",
          key,
          start
        )
        .toArray();
    }
    return this.#sql
      .exec<ThreadEventRow>(
        "SELECT seq, event FROM pss_thread_event WHERE thread_key = ? AND seq >= ? ORDER BY seq LIMIT ?",
        key,
        start,
        limit
      )
      .toArray();
  }

  #rowKey(threadKey: string): string {
    return storeKey(this.#prefix, "thread-events", threadKey);
  }

  #ensureSchema(): void {
    if (this.#schemaReady) {
      return;
    }
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS pss_thread_event (thread_key TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (thread_key, seq))"
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS pss_thread_event_meta (thread_key TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)"
    );
    ensurePayloadChunkSchema(this.#sql);
    this.#schemaReady = true;
  }

  #readNextSeq(key: string): number {
    const row = this.#sql
      .exec<ThreadEventMetaRow>(
        "SELECT next_seq FROM pss_thread_event_meta WHERE thread_key = ?",
        key
      )
      .toArray()[0];
    return row?.next_seq ?? 0;
  }

  #writeNextSeq(key: string, nextSeq: number): void {
    this.#sql.exec(
      "INSERT INTO pss_thread_event_meta (thread_key, next_seq) VALUES (?, ?) ON CONFLICT(thread_key) DO UPDATE SET next_seq = excluded.next_seq",
      key,
      nextSeq
    );
  }

  #payloadLocation(key: string, seq: number) {
    return { ownerKey: key, payloadKey: String(seq), scope: "thread-event" };
  }
}
