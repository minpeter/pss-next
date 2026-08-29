import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";
import { DurableObjectSqliteThreadStore } from "./thread-store";

export const PREFIX = "pss-runtime";
export const REQUIRES_SQLITE = /SQLite-backed/;

interface MessageRowProbe {
  readonly active: number;
  readonly message: string;
  readonly seq: number;
}

interface MessageChunkRowProbe {
  readonly chunk: string;
  readonly chunk_index: number;
  readonly seq: number;
}

interface CompactionRowProbe {
  readonly end_seq_exclusive: number;
  readonly ordinal: number;
  readonly start_seq: number;
  readonly summary: string;
}

export function createStore(
  options: { readonly maxPayloadBytes?: number } = {}
): {
  readonly storage: InMemoryDurableObjectStorage;
  readonly store: DurableObjectSqliteThreadStore;
} {
  const storage = new InMemoryDurableObjectStorage({
    sql: new InMemorySqlStorage(),
  });
  const store = new DurableObjectSqliteThreadStore(storage, PREFIX, options);
  return { storage, store };
}

export function snapshot(history: unknown[]): {
  readonly state: {
    readonly history: unknown[];
    readonly schemaVersion: 1;
  };
} {
  return { state: { history, schemaVersion: 1 } };
}

export function inMemorySql(
  storage: InMemoryDurableObjectStorage
): InMemorySqlStorage {
  if (!(storage.sql instanceof InMemorySqlStorage)) {
    throw new Error("Expected in-memory SQL storage.");
  }
  return storage.sql;
}

export function readRows(
  storage: InMemoryDurableObjectStorage,
  threadKey: string
): MessageRowProbe[] {
  return inMemorySql(storage)
    .exec<MessageRowProbe>(
      "SELECT seq, active, message FROM pss_thread_message WHERE thread_key = ? ORDER BY seq",
      storeKey(PREFIX, "thread", threadKey)
    )
    .toArray();
}

export function readChunkRows(
  storage: InMemoryDurableObjectStorage,
  threadKey: string
): MessageChunkRowProbe[] {
  return inMemorySql(storage)
    .exec<MessageChunkRowProbe>(
      "SELECT seq, chunk_index, chunk FROM pss_thread_message_chunk WHERE thread_key = ? ORDER BY seq, chunk_index",
      storeKey(PREFIX, "thread", threadKey)
    )
    .toArray();
}

export function readCompactionRows(
  storage: InMemoryDurableObjectStorage,
  threadKey: string
): CompactionRowProbe[] {
  return inMemorySql(storage)
    .exec<CompactionRowProbe>(
      "SELECT ordinal, start_seq, end_seq_exclusive, summary FROM pss_thread_compaction WHERE thread_key = ? ORDER BY ordinal",
      storeKey(PREFIX, "thread", threadKey)
    )
    .toArray();
}
