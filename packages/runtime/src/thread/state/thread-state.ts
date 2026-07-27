import type { ModelMessage } from "ai";
import { Fsm } from "../../internal/fsm";
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

/**
 * Persistence lifecycle of a thread's stored state.
 *
 * ```
 * unloaded -> loading -> ready
 *     ^          |         |
 *     |     (load fails)   |
 *     +----------+         |
 *     |                    v
 *     +------------- deleting -> deleted
 *          (delete fails: roll back to the pre-delete tag)
 * ```
 */
type ThreadPersistenceState =
  | { readonly tag: "unloaded" }
  | { readonly tag: "loading"; readonly promise: Promise<void> }
  | { readonly tag: "ready" }
  | {
      readonly tag: "deleting";
      /** State to roll back to when the store delete fails. */
      readonly rollbackTag: "ready" | "unloaded";
    }
  | { readonly tag: "deleted" };

function createThreadPersistenceMachine(): Fsm<ThreadPersistenceState> {
  return new Fsm<ThreadPersistenceState>({
    initial: { tag: "unloaded" },
    name: "thread-persistence",
    transitions: {
      unloaded: ["loading", "deleting"],
      loading: ["ready", "unloaded", "deleting"],
      ready: ["deleting"],
      deleting: ["deleting", "deleted", "ready", "unloaded"],
      deleted: [],
    },
  });
}

export class ThreadState {
  #appliedMigrations: AppliedThreadMigrations = {};
  readonly #machine = createThreadPersistenceMachine();
  readonly #migrations: readonly ThreadStateMigration[];
  readonly #persistence: ThreadPersistenceOptions;
  #history = new ModelMessageHistory();
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

    const promise = this.#replaceWithStoredThread().then(
      () => {
        // A delete may have raced the load; keep the terminal state then.
        this.#machine.toIf("loading", { tag: "ready" });
      },
      (error: unknown) => {
        this.#machine.toIf("loading", { tag: "unloaded" });
        throw error;
      }
    );
    this.#machine.to({ tag: "loading", promise });
    return await promise;
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
    if (this.#machine.in("deleting", "deleted")) {
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
    if (this.#machine.in("deleting", "deleted")) {
      return;
    }

    const snapshot = this.#history.modelSnapshot();
    const compactions = this.#history.compactionSnapshot();
    await this.#enqueueWrite(async () => {
      if (this.#machine.in("deleting", "deleted")) {
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
    const current = this.#machine.state;
    if (current.tag === "deleted") {
      return;
    }

    const rollbackTag = deleteRollbackTag(current);
    const previous = {
      appliedMigrations: this.#appliedMigrations,
      compactions: this.#history.compactionSnapshot(),
      history: this.#history.modelSnapshot(),
      storeVersion: this.#storeVersion,
    };
    this.#machine.to({ tag: "deleting", rollbackTag });

    await this.#enqueueWrite(async () => {
      try {
        await this.#persistence.store.delete(this.#persistence.key);
      } catch (error) {
        if (this.#machine.toIf("deleting", { tag: rollbackTag })) {
          this.#appliedMigrations = previous.appliedMigrations;
          this.#storeVersion = previous.storeVersion;
          this.#history = new ModelMessageHistory(
            previous.history,
            undefined,
            previous.compactions
          );
        }
        throw error;
      }

      this.#machine.toIf("deleting", { tag: "deleted" });
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

  async #replaceWithStoredThread(): Promise<void> {
    const stored = await this.#persistence.store.load(this.#persistence.key);
    let nextVersion = stored?.version;
    let state = decodeStoredThreadState(stored);
    if (stored) {
      if (this.#migrations.length > 0) {
        const migrated = await this.#migrateStoredThread(state, stored.version);
        state = migrated.state;
        nextVersion = migrated.version;
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

  /**
   * Apply configured migrations, retrying when a concurrent writer wins the
   * optimistic commit. After each conflict the latest snapshot is reloaded;
   * pending migrations are re-applied unless the winner already recorded them.
   */
  async #migrateStoredThread(
    initialState: ReturnType<typeof decodeStoredThreadState>,
    initialVersion: string
  ): Promise<{
    readonly state: ReturnType<typeof decodeStoredThreadState>;
    readonly version: string;
  }> {
    let state = initialState;
    let expectedVersion = initialVersion;
    for (let attempt = 0; attempt < MAX_MIGRATION_COMMIT_ATTEMPTS; attempt++) {
      const migrated = await applyThreadStateMigrations({
        migrations: this.#migrations,
        state,
        threadKey: this.#persistence.key,
      });
      if (!migrated.changed) {
        return { state: migrated, version: expectedVersion };
      }
      const result = await this.#persistence.store.commit(
        this.#persistence.key,
        {
          state: encodeThreadSnapshot(
            migrated.history,
            migrated.compactions,
            migrated.appliedMigrations
          ),
        },
        { expectedVersion }
      );
      if (result.ok) {
        return { state: migrated, version: result.version };
      }
      const reloaded = await this.#persistence.store.load(
        this.#persistence.key
      );
      if (reloaded === null) {
        throw new ThreadCommitConflictError(this.#persistence.key);
      }
      state = decodeStoredThreadState(reloaded);
      expectedVersion = reloaded.version;
    }
    throw new ThreadCommitConflictError(this.#persistence.key);
  }
}

const MAX_MIGRATION_COMMIT_ATTEMPTS = 8;

/** State to restore when a delete fails, preserving the pre-delete tag. */
function deleteRollbackTag(
  current: Exclude<ThreadPersistenceState, { tag: "deleted" }>
): "ready" | "unloaded" {
  if (current.tag === "deleting") {
    return current.rollbackTag;
  }
  return current.tag === "ready" ? "ready" : "unloaded";
}

/** @internal exported for unit tests of special-key seeding */
export function seedAppliedMigrations(
  migrations: readonly ThreadStateMigration[]
): AppliedThreadMigrations {
  const applied: Record<string, number> = Object.create(null);
  for (const migration of migrations) {
    Object.defineProperty(applied, migration.id, {
      configurable: true,
      enumerable: true,
      value: migration.version,
      writable: true,
    });
  }
  return applied;
}
