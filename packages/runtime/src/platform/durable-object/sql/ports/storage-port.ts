/**
 * Minimal structural subset of DurableObject's `SqlStorage` that the SQLite-backed
 * thread store depends on. Keeping it narrow lets the store stay decoupled from
 * `@durableObject/workers-types` while remaining assignable from the real
 * `ctx.storage.sql` (a SQLite-backed Durable Object) and from the in-memory
 * `node:sqlite` test double.
 */
export interface SqlStorageCursorLike<T> extends Iterable<T> {
  toArray(): T[];
}

export interface SqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T>;
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
  transactionSync?<T>(fn: () => T): T;
}
