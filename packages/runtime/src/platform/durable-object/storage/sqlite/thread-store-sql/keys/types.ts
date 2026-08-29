import type { SqlStorage } from "../../../../sql/ports/storage-port";
import { storeKey } from "../../../execution/records";

export interface ThreadMetaRow {
  readonly applied_migrations: string | null;
  readonly message_count: number;
  readonly next_seq: number;
  readonly state_blob: string | null;
  readonly version: string;
}

export interface ThreadMessageRow {
  readonly message: string;
  readonly seq: number;
}

export interface StoredThreadCompactionRecord {
  readonly endSeqExclusive: number;
  readonly schemaVersion: 1;
  readonly startSeq: number;
  readonly summary: unknown;
}

export interface RawThreadMessageRow {
  readonly message: string;
  readonly seq: number;
}

export interface ThreadMessageChunkRow {
  readonly chunk: string;
  readonly chunk_index: number;
  readonly seq: number;
}

export interface ThreadMessageChunkMarker {
  readonly n: number;
}

export interface SerializedThreadCompactionRow {
  readonly endSeqExclusive: number;
  readonly ordinal: number;
  readonly startSeq: number;
  readonly summary: string;
}

export interface WriteHistoryRowsOptions {
  readonly history: readonly unknown[];
  readonly key: string;
  readonly maxPayloadBytes: number;
  readonly meta: ThreadMetaRow | null;
  readonly nextSeqStart: number;
  readonly sql: SqlStorage;
}

export function threadRowKey(prefix: string, threadKey: string): string {
  return storeKey(prefix, "thread", threadKey);
}
