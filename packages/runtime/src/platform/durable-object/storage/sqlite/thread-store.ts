import type {
  CommitResult,
  ExpectedThreadVersion,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "../../../../index";
import { isAgentThreadSnapshot } from "../../../../thread/state/snapshot";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { DurableObjectStorage } from "../durable-object/durable-object-storage";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
  stringifyJsonPayloadWithinBudget,
} from "../payload-guard";
import {
  deleteThreadCompactions,
  deleteThreadRows,
  ensureThreadSchema,
  readActiveThreadMessages,
  readThreadCompactions,
  readThreadMeta,
  serializeThreadCompactions,
  softDeleteActiveThreadRows,
  threadRowKey,
  writeThreadCompactions,
  writeThreadHistoryRows,
  writeThreadMeta,
} from "./thread-store-sql";

/**
 * Append-only thread store for SQLite-backed Durable Objects.
 *
 * Snapshot v1 state (`{ schemaVersion: 1, history }`) is split into rows. Any
 * other opaque state is stored verbatim in a single meta blob column, so the
 * store remains a correct drop-in {@link ThreadStore} for non-snapshot callers.
 *
 * Concurrency: the optimistic version check and the row writes form a single
 * synchronous (await-free) read-modify-write section, so concurrent commits to
 * the same key serialize on the JS event loop inside the single-threaded
 * Durable Object — exactly one writer wins, the rest get a `conflict`.
 */
export class DurableObjectSqliteThreadStore implements ThreadStore {
  readonly #maxPayloadBytes: number;
  readonly #prefix: string;
  readonly #sql: SqlStorage;
  readonly #transaction: <T>(operation: () => T) => Promise<T>;
  #schemaReady = false;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(
    storage: DurableObjectStorage,
    prefix: string,
    options: StoragePayloadBudgetOptions = {}
  ) {
    const sql = storage.sql as SqlStorage | undefined;
    if (!sql) {
      throw new Error(
        "DurableObjectSqliteThreadStore requires a SQLite-backed Durable Object (storage.sql is unavailable)"
      );
    }
    this.#maxPayloadBytes = resolveStoragePayloadMaxBytes(options);
    this.#prefix = prefix;
    this.#sql = sql;
    this.#transaction = createStorageTransaction(storage, sql);
  }

  async commit(
    threadKey: string,
    next: ThreadStoreCommit,
    options: { readonly expectedVersion: ExpectedThreadVersion }
  ): Promise<CommitResult> {
    try {
      this.#ensureSchema();
      const key = this.#rowKey(threadKey);

      const prepared = isAgentThreadSnapshot(next.state)
        ? {
            kind: "snapshot" as const,
            compactions: serializeThreadCompactions(
              next.state.schemaVersion === 1 ? [] : next.state.compactions,
              this.#maxPayloadBytes
            ),
            state: next.state,
            appliedMigrationsJson:
              next.state.schemaVersion === 3
                ? stringifyJsonPayloadWithinBudget(
                    "thread-applied-migrations",
                    next.state.appliedMigrations,
                    this.#maxPayloadBytes
                  )
                : null,
          }
        : {
            kind: "opaque" as const,
            stateBlob: stringifyJsonPayloadWithinBudget(
              "thread-state",
              next.state ?? null,
              this.#maxPayloadBytes
            ),
          };

      return await this.#enqueueWrite(() =>
        this.#transaction(() => {
          // --- begin synchronous read-modify-write critical section (no await) ---
          const meta = readThreadMeta(this.#sql, key);
          const currentVersion = meta ? meta.version : null;
          if (options.expectedVersion !== currentVersion) {
            return { ok: false, reason: "conflict" };
          }

          const version = String(versionCounter(meta?.version) + 1);
          const nextSeqStart = meta?.next_seq ?? 0;

          if (prepared.kind === "snapshot") {
            const nextSeq = writeThreadHistoryRows({
              history: prepared.state.history,
              key,
              maxPayloadBytes: this.#maxPayloadBytes,
              meta,
              nextSeqStart,
              sql: this.#sql,
            });
            writeThreadCompactions(this.#sql, key, prepared.compactions);
            writeThreadMeta(this.#sql, key, {
              applied_migrations: prepared.appliedMigrationsJson,
              message_count: prepared.state.history.length,
              next_seq: nextSeq,
              state_blob: null,
              version,
            });
          } else {
            softDeleteActiveThreadRows(this.#sql, key);
            deleteThreadCompactions(this.#sql, key);
            writeThreadMeta(this.#sql, key, {
              applied_migrations: null,
              message_count: 0,
              next_seq: nextSeqStart,
              state_blob: prepared.stateBlob,
              version,
            });
          }
          // --- end critical section ---

          return { ok: true, version };
        })
      );
    } catch (error) {
      if (error instanceof Error) {
        return Promise.reject(error);
      }
      throw error;
    }
  }

  async delete(threadKey: string): Promise<void> {
    this.#ensureSchema();
    const key = this.#rowKey(threadKey);
    await this.#enqueueWrite(() =>
      this.#transaction(() => {
        deleteThreadRows(this.#sql, key);
      })
    );
  }

  load(threadKey: string): Promise<StoredThread | null> {
    this.#ensureSchema();
    const key = this.#rowKey(threadKey);

    const meta = readThreadMeta(this.#sql, key);
    if (!meta) {
      return Promise.resolve(null);
    }
    const version = meta.version;
    if (meta.state_blob !== null) {
      const state: unknown = JSON.parse(meta.state_blob);
      return Promise.resolve({ state, version });
    }
    const history: unknown[] = readActiveThreadMessages(this.#sql, key).map(
      (row) => JSON.parse(row.message)
    );
    const compactions = readThreadCompactions(this.#sql, key);
    if (meta.applied_migrations !== null) {
      const appliedMigrations = parseAppliedMigrations(meta.applied_migrations);
      return Promise.resolve({
        state: {
          appliedMigrations,
          compactions,
          history,
          schemaVersion: 3,
        } as const,
        version,
      });
    }
    if (compactions.length > 0) {
      return Promise.resolve({
        state: { compactions, history, schemaVersion: 2 },
        version,
      });
    }
    return Promise.resolve({ state: { history, schemaVersion: 1 }, version });
  }

  #rowKey(threadKey: string): string {
    return threadRowKey(this.#prefix, threadKey);
  }

  #ensureSchema(): void {
    if (this.#schemaReady) {
      return;
    }
    ensureThreadSchema(this.#sql);
    this.#schemaReady = true;
  }

  #enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#writeQueue.then(operation, operation);
    this.#writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function versionCounter(version: string | undefined): number {
  const parsed = Number(version);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseAppliedMigrations(
  serialized: string
): Readonly<Record<string, number>> {
  try {
    const value: unknown = JSON.parse(serialized);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const result: Record<string, number> = {};
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>
      )) {
        if (typeof item === "number" && Number.isFinite(item)) {
          result[key] = item;
        }
      }
      return result;
    }
  } catch {
    return {};
  }
  return {};
}

function createStorageTransaction(
  storage: DurableObjectStorage,
  sql: SqlStorage
): <T>(operation: () => T) => Promise<T> {
  const transactionSync = storage.transactionSync?.bind(storage);
  if (transactionSync) {
    return <T>(operation: () => T) =>
      Promise.resolve(transactionSync(operation));
  }

  const transaction = storage.transaction?.bind(storage);
  if (transaction) {
    return <T>(operation: () => T) => transaction(async () => operation());
  }

  const sqlTransaction = sql.transaction?.bind(sql);
  if (sqlTransaction) {
    return <T>(operation: () => T) => sqlTransaction(async () => operation());
  }

  throw new Error(
    "DurableObjectSqliteThreadStore requires Durable Object storage transaction support."
  );
}
