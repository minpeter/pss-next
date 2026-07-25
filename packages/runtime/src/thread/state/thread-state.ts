import type { ModelMessage } from "ai";
import type {
  CommitResult,
  ExpectedThreadVersion,
  ThreadStore,
  ThreadStoreCommit,
} from "../store/types";
import type { ThreadContextMessage } from "./context";
import { ModelMessageHistory } from "./history";
import {
  type AppliedThreadMigrations,
  applyThreadStateMigrations,
  normalizeThreadStateMigrations,
  type ThreadStateMigration,
} from "./migrations";
import {
  decodeStoredThreadState,
  encodeThreadSnapshot,
  type ThreadCompactionRecord,
} from "./snapshot";

export interface ThreadPersistenceOptions {
  readonly key: string;
  readonly migrations?: readonly ThreadStateMigration[];
  readonly store: ThreadStore;
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

export class ThreadState {
  #appliedMigrations: AppliedThreadMigrations = {};
  readonly #migrations: readonly ThreadStateMigration[];
  readonly #persistence: ThreadPersistenceOptions;
  #deleteRequested = false;
  #history = new ModelMessageHistory();
  #deleted = false;
  #loadPromise?: Promise<void>;
  #loaded = false;
  #storeVersion: string | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(persistence: ThreadPersistenceOptions) {
    this.#persistence = persistence;
    this.#migrations = normalizeThreadStateMigrations(persistence.migrations);
  }

  get history(): ModelMessageHistory {
    return this.#history;
  }

  async ensureLoaded(): Promise<void> {
    if (this.#deleteRequested || this.#deleted) {
      return;
    }

    if (this.#loaded) {
      return;
    }

    this.#loadPromise ??= this.#loadThreadState();
    try {
      await this.#loadPromise;
    } catch (error) {
      this.#loadPromise = undefined;
      throw error;
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
      threadVersion: this.#storeVersion ?? null,
    };
  }

  appendUserInput(
    input: Parameters<ModelMessageHistory["appendUserInput"]>[0]
  ) {
    this.#history.appendUserInput(input);
  }

  appendTransientUserInput(
    input: Parameters<ModelMessageHistory["appendTransientUserInput"]>[0]
  ) {
    this.#history.appendTransientUserInput(input);
  }

  clearTransientInputs(): void {
    this.#history.clearTransientInputs();
  }

  rollback(snapshot: ModelMessage[]): void {
    this.#history.rollback(snapshot);
  }

  async compact(input: ThreadCompactionInput): Promise<void> {
    if (this.#deleteRequested || this.#deleted) {
      return;
    }

    const previous = {
      compactions: this.#history.compactionSnapshot(),
      history: this.#history.modelSnapshot(),
      storeVersion: this.#storeVersion,
    };
    const record: ThreadCompactionRecord = {
      endSeqExclusive: input.endSeqExclusive,
      schemaVersion: 1,
      startSeq: input.startSeq,
      summary: { content: input.summary, role: "system" },
    };
    this.#history.recordCompaction(record);
    try {
      await this.commit();
    } catch (error) {
      if (!(error instanceof ThreadCommitConflictError)) {
        this.#storeVersion = previous.storeVersion;
        this.#history = new ModelMessageHistory(
          previous.history,
          undefined,
          previous.compactions
        );
      }
      throw error;
    }
  }

  async commit(): Promise<void> {
    await this.commitWith(
      async (commit) =>
        await this.#persistence.store.commit(commit.key, commit.next, {
          expectedVersion: commit.expectedVersion,
        })
    );
  }

  async commitWith(
    commit: (input: PreparedThreadCommit) => Promise<CommitResult>
  ): Promise<void> {
    if (this.#deleteRequested || this.#deleted) {
      return;
    }

    const snapshot = this.#history.modelSnapshot();
    const compactions = this.#history.compactionSnapshot();
    await this.#enqueueWrite(async () => {
      if (this.#deleteRequested || this.#deleted) {
        return;
      }

      const result = await commit({
        expectedVersion: this.#storeVersion ?? null,
        key: this.#persistence.key,
        next: {
          state: encodeThreadSnapshot(
            snapshot,
            compactions,
            this.#appliedMigrations
          ),
        },
      });

      if (!result.ok) {
        await this.#replaceWithStoredThread();
        throw new ThreadCommitConflictError(this.#persistence.key);
      }

      this.#storeVersion = result.version;
    });
  }

  async delete(): Promise<void> {
    if (this.#deleted) {
      return;
    }

    const previous = {
      appliedMigrations: this.#appliedMigrations,
      compactions: this.#history.compactionSnapshot(),
      history: this.#history.modelSnapshot(),
      loaded: this.#loaded,
      storeVersion: this.#storeVersion,
    };
    this.#deleteRequested = true;
    this.#loadPromise = undefined;

    await this.#enqueueWrite(async () => {
      try {
        await this.#persistence.store.delete(this.#persistence.key);
      } catch (error) {
        this.#deleteRequested = false;
        this.#appliedMigrations = previous.appliedMigrations;
        this.#loaded = previous.loaded;
        this.#storeVersion = previous.storeVersion;
        this.#history = new ModelMessageHistory(
          previous.history,
          undefined,
          previous.compactions
        );
        throw error;
      }

      this.#deleted = true;
      this.#loadPromise = undefined;
      this.#loaded = true;
      this.#storeVersion = undefined;
      this.#appliedMigrations = {};
      this.#history = new ModelMessageHistory();
    });
  }

  #enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.#writeQueue.then(operation, operation);
    this.#writeQueue = next.catch(() => undefined);
    return next;
  }

  async #loadThreadState(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    await this.#replaceWithStoredThread();
    this.#loaded = true;
  }

  async #replaceWithStoredThread(): Promise<void> {
    const stored = await this.#persistence.store.load(this.#persistence.key);
    let nextVersion = stored?.version;
    let state = decodeStoredThreadState(stored);
    if (stored) {
      if (this.#migrations.length > 0) {
        const migrated = await applyThreadStateMigrations({
          migrations: this.#migrations,
          state,
          threadKey: this.#persistence.key,
        });
        if (migrated.changed) {
          const result = await this.#persistence.store.commit(
            this.#persistence.key,
            {
              state: encodeThreadSnapshot(
                migrated.history,
                migrated.compactions,
                migrated.appliedMigrations
              ),
            },
            { expectedVersion: stored.version }
          );
          if (result.ok) {
            state = migrated;
            nextVersion = result.version;
          } else {
            // Another writer already committed this migration; reload the
            // now-migrated snapshot instead of surfacing a spurious conflict.
            const reloaded = await this.#persistence.store.load(
              this.#persistence.key
            );
            if (reloaded === null) {
              throw new ThreadCommitConflictError(this.#persistence.key);
            }
            state = decodeStoredThreadState(reloaded);
            nextVersion = reloaded.version;
          }
        }
      }
    } else if (this.#migrations.length > 0) {
      // New threads are post-migration state; mark every configured
      // migration as already applied so they are not re-applied on restart.
      state = {
        ...state,
        appliedMigrations: seedAppliedMigrations(this.#migrations),
      };
    }
    this.#appliedMigrations = state.appliedMigrations;
    this.#storeVersion = nextVersion;
    this.#history = new ModelMessageHistory(
      state.history,
      undefined,
      state.compactions
    );
  }
}

function seedAppliedMigrations(
  migrations: readonly ThreadStateMigration[]
): AppliedThreadMigrations {
  const applied: Record<string, number> = {};
  for (const migration of migrations) {
    applied[migration.id] = migration.version;
  }
  return applied;
}
