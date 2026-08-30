import type { ModelMessage } from "ai";
import { deferred } from "../../internal/deferred";
import type {
  CommitResult,
  ExpectedThreadVersion,
  ThreadStore,
  ThreadStoreCommit,
} from "../store/types";
import type { ThreadContextMessage } from "./context";
import { ModelMessageHistory, recordCompactionForCommit } from "./history";
import type { ThreadStateMigration } from "./migrations";
import type { ThreadCompactionRecord } from "./snapshot";
import {
  createThreadPersistenceMachine,
  seedAppliedMigrations as seedAppliedMigrationMarkers,
  type ThreadCommitBoundaryOptions,
  ThreadStatePersistence,
  ThreadWriteQueue,
} from "./thread-state-persistence";

/** @internal exported for unit tests of special-key seeding */
export const seedAppliedMigrations = seedAppliedMigrationMarkers;

export interface ThreadPersistenceOptions {
  readonly key: string;
  readonly migrations?: readonly ThreadStateMigration[];
  readonly store: ThreadStore;
}

export interface PreparedThreadCommit {
  readonly expectedVersion: ExpectedThreadVersion;
  readonly key: string;
  readonly next: ThreadStoreCommit;
}

export class ThreadCommitConflictError extends Error {
  constructor(key: string) {
    super(`Thread ${JSON.stringify(key)} commit conflict`);
  }
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

type HistoryUserInput = Parameters<ModelMessageHistory["appendUserInput"]>[0];

export class ThreadState {
  /** Opaque identity for runtime-owned per-thread caches. */
  readonly compactionIdentity: object = Object.freeze({});
  readonly #machine = createThreadPersistenceMachine();
  readonly #persistence: ThreadStatePersistence;
  #history = new ModelMessageHistory();
  readonly #writes = new ThreadWriteQueue();

  constructor(persistence: ThreadPersistenceOptions) {
    this.#persistence = new ThreadStatePersistence(
      persistence,
      ThreadCommitConflictError
    );
  }

  get history(): ModelMessageHistory {
    return this.#history;
  }

  async ensureLoaded(): Promise<void> {
    const current = this.#machine.state;
    if (
      current.tag === "ready" ||
      current.tag === "deleting" ||
      current.tag === "deleted"
    ) {
      return;
    }

    if (current.tag === "loading") {
      return await current.promise;
    }

    const load = deferred();
    // Transition before wiring the continuation so the machine state never
    // depends on microtask scheduling.
    this.#machine.to({ tag: "loading", promise: load.promise });
    this.#persistence.load().then(
      (applySnapshot) => {
        // A delete may have superseded the load; discard the snapshot then
        // so a slow load cannot resurrect deleted state in memory.
        if (this.#machine.toIf("loading", { tag: "ready" })) {
          this.#history = applySnapshot() ?? this.#history;
        }
        load.resolve();
      },
      (error: unknown) => {
        this.#machine.toIf("loading", { tag: "unloaded" });
        load.reject(error);
      }
    );
    return await load.promise;
  }

  async refresh(): Promise<void> {
    await this.ensureLoaded();
    if (this.#machine.in("deleting", "deleted")) {
      return;
    }
    const applySnapshot = await this.#persistence.load();
    if (!this.#machine.in("deleting", "deleted")) {
      this.#history = applySnapshot() ?? this.#history;
    }
  }

  modelSnapshot(): ModelMessage[] {
    return this.#history.modelSnapshot();
  }

  modelContextSnapshot(): ThreadContextMessage[] {
    return this.#history.modelContextSnapshot();
  }

  compactionSnapshot(): ThreadCompactionRecord[] {
    return this.#history.compactionSnapshot();
  }

  threadCheckpointReference(): ThreadCheckpointReference {
    return {
      kind: "thread-reference",
      schemaVersion: 1,
      threadKey: this.#persistence.key,
      threadVersion: this.#persistence.checkpointVersion,
    };
  }

  appendUserInput(input: HistoryUserInput) {
    this.#history.appendUserInput(input);
  }

  appendTransientUserInput(input: HistoryUserInput) {
    this.#history.appendTransientUserInput(input);
  }

  clearTransientInputs(): void {
    this.#history.clearTransientInputs();
  }

  rollback(snapshot: ModelMessage[]): void {
    this.#history.rollback(snapshot);
  }

  async compact(
    input: ThreadCompactionInput,
    options: ThreadCommitBoundaryOptions = {}
  ): Promise<boolean> {
    if (this.#machine.in("deleting", "deleted")) {
      return false;
    }

    return await this.#writes.enqueue(async () => {
      if (this.#machine.in("deleting", "deleted")) {
        return false;
      }
      if (options.isFresh && !options.isFresh()) {
        return false;
      }

      const rollbackCompaction = recordCompactionForCommit(this.#history, {
        endSeqExclusive: input.endSeqExclusive,
        schemaVersion: 1,
        startSeq: input.startSeq,
        summary: { content: input.summary, role: "system" },
      });
      try {
        await this.#commitSnapshotWith(
          (commit) => this.#persistence.commit(commit),
          options
        );
      } catch (error) {
        rollbackCompaction();
        throw error;
      }
      return true;
    }, options.signal);
  }

  async commit(): Promise<void> {
    await this.commitWith((commit) => this.#persistence.commit(commit));
  }

  async commitWith(
    commit: (input: PreparedThreadCommit) => Promise<CommitResult>,
    options: ThreadCommitBoundaryOptions = {}
  ): Promise<void> {
    if (this.#machine.in("deleting", "deleted")) {
      return;
    }

    await this.#writes.enqueue(async () => {
      if (this.#machine.in("deleting", "deleted")) {
        return;
      }

      await this.#commitSnapshotWith(commit, options);
    }, options.signal);
  }

  async delete(remove = () => this.#persistence.delete()): Promise<void> {
    const current = this.#machine.state;
    if (current.tag === "deleted") {
      return;
    }
    if (current.tag === "deleting") {
      // A delete is already in flight; share it instead of issuing another
      // store delete.
      return await current.promise;
    }

    const rollbackTag = current.tag === "ready" ? "ready" : "unloaded";
    const del = deferred();
    // Transition before wiring the continuation so the machine state never
    // depends on microtask scheduling.
    this.#machine.to({ tag: "deleting", promise: del.promise, rollbackTag });
    this.#writes
      .enqueue(async () => {
        const previous = {
          compactions: this.#history.compactionSnapshot(),
          history: this.#history.modelSnapshot(),
          persistence: this.#persistence.captureMetadata(),
        };
        try {
          await remove();
        } catch (error) {
          if (this.#machine.toIf("deleting", { tag: rollbackTag })) {
            this.#persistence.restoreMetadata(previous.persistence);
            this.#history = new ModelMessageHistory(
              previous.history,
              undefined,
              previous.compactions
            );
          }
          throw error;
        }

        this.#machine.toIf("deleting", { tag: "deleted" });
        this.#persistence.clearMetadata();
        this.#history = new ModelMessageHistory();
      })
      .then(del.resolve, del.reject);
    return await del.promise;
  }

  async #commitSnapshotWith(
    commit: (input: PreparedThreadCommit) => Promise<CommitResult>,
    options: ThreadCommitBoundaryOptions
  ): Promise<void> {
    const snapshot = this.#history.modelSnapshot();
    const prepared = this.#persistence.prepareCommit(
      snapshot,
      this.#history.compactionSnapshot()
    );
    options.enterCommitBoundary?.();
    const result = await commit(prepared);

    if (!result.ok) {
      await this.#replaceWithStoredThread(snapshot);
      throw new ThreadCommitConflictError(this.#persistence.key);
    }

    this.#persistence.acceptCommit(result.version);
  }

  async #replaceWithStoredThread(
    attemptedHistory?: readonly ModelMessage[]
  ): Promise<void> {
    const apply = await this.#persistence.load();
    this.#history =
      apply(
        attemptedHistory === undefined
          ? undefined
          : {
              attemptedHistory,
              currentLocalHistory: this.#history.modelSnapshot(),
            }
      ) ?? this.#history;
  }
}
