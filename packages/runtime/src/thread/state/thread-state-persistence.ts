import type { ModelMessage } from "ai";
import { Fsm } from "../../fsm";
import type { CommitResult, ThreadStore } from "../store/types";
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
import { conflictAppendSuffix } from "./snapshot-equal";
import type {
  PreparedThreadCommit,
  ThreadPersistenceOptions,
} from "./thread-state";

export interface ThreadCommitBoundaryOptions {
  readonly enterCommitBoundary?: () => void;
  readonly isFresh?: () => boolean;
  readonly signal?: AbortSignal;
}

interface ConflictHistoryReconciliation {
  readonly attemptedHistory: readonly ModelMessage[];
  readonly currentLocalHistory: readonly ModelMessage[];
}

export type ApplyLoadedThreadSnapshot = (
  conflict?: ConflictHistoryReconciliation
) => ModelMessageHistory | undefined;

interface PersistenceMetadata {
  readonly appliedMigrations: AppliedThreadMigrations;
  readonly storeVersion: string | undefined;
}

interface ThreadCommitConflictErrorConstructor {
  new (key: string): Error;
}

type ThreadPersistenceState =
  | { readonly tag: "unloaded" }
  | { readonly tag: "loading"; readonly promise: Promise<void> }
  | { readonly tag: "ready" }
  | {
      readonly tag: "deleting";
      readonly promise: Promise<void>;
      readonly rollbackTag: "ready" | "unloaded";
    }
  | { readonly tag: "deleted" };

export function createThreadPersistenceMachine(): Fsm<ThreadPersistenceState> {
  return new Fsm<ThreadPersistenceState>({
    initial: { tag: "unloaded" },
    name: "thread-persistence",
    transitions: {
      unloaded: ["loading", "deleting"],
      loading: ["ready", "unloaded", "deleting"],
      ready: ["deleting"],
      deleting: ["deleted", "ready", "unloaded"],
      deleted: [],
    },
  });
}

export class ThreadWriteQueue {
  #settled: Promise<void> = Promise.resolve();

  enqueue<Result>(
    operation: () => Promise<Result>,
    signal?: AbortSignal
  ): Promise<Result> {
    const run = async () => {
      signal?.throwIfAborted();
      return await operation();
    };
    const next = this.#settled.then(run, run);
    this.#settled = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

export class ThreadStatePersistence {
  #appliedMigrations: AppliedThreadMigrations = {};
  readonly #conflictError: ThreadCommitConflictErrorConstructor;
  readonly #key: string;
  readonly #migrations: readonly ThreadStateMigration[];
  readonly #store: ThreadStore;
  #loadGeneration = 0;
  #storeVersion: string | undefined;

  constructor(
    options: ThreadPersistenceOptions,
    conflictError: ThreadCommitConflictErrorConstructor
  ) {
    this.#conflictError = conflictError;
    this.#key = options.key;
    this.#migrations = normalizeThreadStateMigrations(options.migrations);
    this.#store = options.store;
  }

  get key(): string {
    return this.#key;
  }

  get checkpointVersion(): string | null {
    return this.#storeVersion ?? null;
  }

  captureMetadata(): PersistenceMetadata {
    return {
      appliedMigrations: this.#appliedMigrations,
      storeVersion: this.#storeVersion,
    };
  }

  restoreMetadata(metadata: PersistenceMetadata): void {
    this.#appliedMigrations = metadata.appliedMigrations;
    this.#storeVersion = metadata.storeVersion;
  }

  clearMetadata(): void {
    this.#appliedMigrations = {};
    this.#storeVersion = undefined;
  }

  prepareCommit(
    history: readonly ModelMessage[],
    compactions: readonly ThreadCompactionRecord[]
  ): PreparedThreadCommit {
    this.#loadGeneration += 1;
    return {
      expectedVersion: this.#storeVersion ?? null,
      key: this.#key,
      next: {
        state: encodeThreadSnapshot(
          history,
          compactions,
          this.#appliedMigrations
        ),
      },
    };
  }

  commit(prepared: PreparedThreadCommit): Promise<CommitResult> {
    return this.#store.commit(prepared.key, prepared.next, {
      expectedVersion: prepared.expectedVersion,
    });
  }

  acceptCommit(version: string): void {
    this.#loadGeneration += 1;
    this.#storeVersion = version;
  }

  delete(): Promise<void> {
    return this.#store.delete(this.#key);
  }

  async load(): Promise<ApplyLoadedThreadSnapshot> {
    const loadGeneration = ++this.#loadGeneration;
    const stored = await this.#store.load(this.#key);
    let nextVersion = stored?.version;
    let state = decodeStoredThreadState(stored);
    if (stored) {
      if (this.#migrations.length > 0) {
        const migrated = await this.#migrate(state, stored.version);
        state = migrated.state;
        nextVersion = migrated.version;
      }
    } else if (this.#migrations.length > 0) {
      state = {
        ...state,
        appliedMigrations: seedAppliedMigrations(this.#migrations),
      };
    }
    return (conflict) => {
      if (loadGeneration !== this.#loadGeneration) {
        return;
      }
      const suffix =
        stored === null || conflict === undefined
          ? []
          : conflictAppendSuffix(
              conflict.attemptedHistory,
              conflict.currentLocalHistory,
              state.history
            );
      this.#appliedMigrations = state.appliedMigrations;
      this.#storeVersion = nextVersion;
      return new ModelMessageHistory(
        [...state.history, ...suffix],
        undefined,
        state.compactions
      );
    };
  }

  async #migrate(
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
        threadKey: this.#key,
      });
      if (!migrated.changed) {
        return { state: migrated, version: expectedVersion };
      }
      const result = await this.#store.commit(
        this.#key,
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
      const reloaded = await this.#store.load(this.#key);
      if (reloaded === null) {
        throw new this.#conflictError(this.#key);
      }
      state = decodeStoredThreadState(reloaded);
      expectedVersion = reloaded.version;
    }
    throw new this.#conflictError(this.#key);
  }
}

const MAX_MIGRATION_COMMIT_ATTEMPTS = 8;

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
