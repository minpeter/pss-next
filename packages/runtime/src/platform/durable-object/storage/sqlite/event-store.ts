import type {
  EventCursor,
  EventStore,
  StoredAgentEvent,
} from "../../../../execution";
import {
  createEventCursor,
  normalizeEventCursor,
} from "../../../../execution/host/event-cursors";
import type { AgentEvent } from "../../../../index";
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

interface EventRow {
  readonly event: string;
  readonly seq: number;
}

interface EventMetaRow {
  readonly next_seq: number;
}

/**
 * Append-only SQLite-backed {@link EventStore} for SQLite-backed Durable Objects.
 *
 * Each `append` only `INSERT`s the new event as one small SQLite row, so no
 * single stored value grows with the run length.
 *
 * Mirrors the design of {@link DurableObjectSqliteThreadStore}: the per-run
 * `next_seq` counter and the row `INSERT` form a single synchronous
 * (await-free) read-modify-write section, so concurrent appends to the same run
 * serialize on the JS event loop inside the single-threaded Durable Object and
 * no `seq` collision can occur.
 *
 * Event cursors are 1-based skip counts (`offset = seq + 1`).
 */
export class DurableObjectSqliteEventStore implements EventStore {
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
        "DurableObjectSqliteEventStore requires a SQLite-backed Durable Object (storage.sql is unavailable)"
      );
    }
    this.#maxPayloadBytes = resolveStoragePayloadMaxBytes(options);
    this.#prefix = prefix;
    this.#sql = sql;
  }

  append(runId: string, event: AgentEvent): Promise<EventCursor> {
    return new Promise((resolve) => {
      this.#ensureSchema();
      const key = this.#rowKey(runId);
      // Synchronous read-modify-write critical section (no await): concurrent
      // appends to the same run serialize on the JS event loop inside the
      // single-threaded Durable Object, so no `seq` collision can occur.
      const seq = this.#readNextSeq(key);
      const serializedEvent = writeJsonPayloadToSqlRows(
        this.#sql,
        this.#payloadLocation(key, seq),
        "event",
        event,
        this.#maxPayloadBytes
      );
      this.#sql.exec(
        "INSERT INTO pss_event (run_key, seq, event) VALUES (?, ?, ?)",
        key,
        seq,
        serializedEvent
      );
      this.#writeNextSeq(key, seq + 1);
      resolve(createEventCursor(seq + 1));
    });
  }

  async *read(
    runId: string,
    cursor?: EventCursor
  ): AsyncIterable<StoredAgentEvent> {
    await Promise.resolve();
    this.#ensureSchema();
    const key = this.#rowKey(runId);
    const start = normalizeEventCursor(cursor);
    const rows = this.#sql
      .exec<EventRow>(
        "SELECT seq, event FROM pss_event WHERE run_key = ? AND seq >= ? ORDER BY seq",
        key,
        start
      )
      .toArray();
    const payloads = readJsonPayloadsFromSqlRows(
      this.#sql,
      "event",
      key,
      rows.map((row) => ({
        payloadKey: String(row.seq),
        storedPayload: row.event,
      }))
    );
    for (const row of rows) {
      const event = payloads.get(String(row.seq));
      if (event === undefined) {
        throw new Error(`Missing event payload for ${key} seq ${row.seq}`);
      }
      yield {
        cursor: createEventCursor(row.seq + 1),
        event: JSON.parse(event) as AgentEvent,
        runId,
      };
    }
  }

  #rowKey(runId: string): string {
    return storeKey(this.#prefix, "events", runId);
  }

  #ensureSchema(): void {
    if (this.#schemaReady) {
      return;
    }
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS pss_event (run_key TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (run_key, seq))"
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS pss_event_meta (run_key TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)"
    );
    ensurePayloadChunkSchema(this.#sql);
    this.#schemaReady = true;
  }

  #readNextSeq(key: string): number {
    const row = this.#sql
      .exec<EventMetaRow>(
        "SELECT next_seq FROM pss_event_meta WHERE run_key = ?",
        key
      )
      .toArray()[0];
    return row?.next_seq ?? 0;
  }

  #writeNextSeq(key: string, nextSeq: number): void {
    this.#sql.exec(
      "INSERT INTO pss_event_meta (run_key, next_seq) VALUES (?, ?) ON CONFLICT(run_key) DO UPDATE SET next_seq = excluded.next_seq",
      key,
      nextSeq
    );
  }

  #payloadLocation(key: string, seq: number) {
    return { ownerKey: key, payloadKey: String(seq), scope: "event" };
  }
}
