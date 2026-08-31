import type {
  ExpectedThreadVersion,
  ThreadStore,
  ThreadStoreCommit,
} from "../store/types";
import type { ThreadStateMigration } from "./migrations";

export interface ThreadPersistenceOptions {
  readonly compactionOwner?: Readonly<object>;
  readonly key: string;
  readonly migrations?: readonly ThreadStateMigration[];
  readonly store: ThreadStore;
}

export interface PreparedThreadCommit {
  readonly expectedVersion: ExpectedThreadVersion;
  readonly key: string;
  readonly next: ThreadStoreCommit;
}

export interface ThreadCheckpointReference {
  readonly kind: "thread-reference";
  readonly schemaVersion: 1;
  readonly threadKey: string;
  readonly threadVersion: string | null;
}

export interface ThreadCompactionInput {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
  readonly summary: string;
}
