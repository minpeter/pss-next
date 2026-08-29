import { DatabaseSync } from "node:sqlite";
import type { SqlStorage, SqlStorageCursorLike } from "../ports/storage-port";

type SqlBinding = bigint | null | number | string;

const RETURNS_ROWS = /^\s*(select|with|pragma)\b/i;
const HAS_RETURNING = /\breturning\b/i;

/**
 * Test double for {@link SqlStorage} backed by Node's built-in `node:sqlite`
 * (`DatabaseSync`, available in Node 24+ — no extra dependency). It mirrors the
 * synchronous cursor shape of a real Durable Object runtime `ctx.storage.sql.exec`, so the
 * thread store can be exercised in plain vitest without a Workers runtime.
 *
 * This is test support only and is intentionally NOT re-exported from the
 * package barrel.
 */
export class InMemorySqlStorage implements SqlStorage {
  readonly #db = new DatabaseSync(":memory:");

  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T> {
    const params = bindings as SqlBinding[];
    if (RETURNS_ROWS.test(query) || HAS_RETURNING.test(query)) {
      const rows = this.#db.prepare(query).all(...params) as T[];
      return toCursor(rows);
    }
    if (params.length === 0) {
      this.#db.exec(query);
      return toCursor<T>([]);
    }
    this.#db.prepare(query).run(...params);
    return toCursor<T>([]);
  }
}

function toCursor<T>(rows: T[]): SqlStorageCursorLike<T> {
  return {
    toArray: () => rows,
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}
