import type { SqlStorage, SqlStorageCursorLike } from "../ports/storage-port";
import {
  isScheduledWorkOffsetQuery,
  scheduledWorkTableInfoRows,
  selectScheduledWorkRowsWithOffset,
} from "./scheduled-work-select";
import { selectSqlRows } from "./select";
import {
  cloneInMemoryDurableObjectSqlState,
  createInMemoryDurableObjectSqlState,
  type InMemoryDurableObjectSqlState,
} from "./state";
import { writeSqlStatement } from "./write";

export class InMemoryDurableObjectSqlStorage implements SqlStorage {
  #state: InMemoryDurableObjectSqlState = createInMemoryDurableObjectSqlState();

  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T> {
    const normalized = normalizeSql(query);
    if (normalized === "pragma table_info(pss_thread_meta)") {
      return toCursor<T>(
        [...this.#state.threadMetaColumns].map((name) => ({ name }))
      );
    }
    if (normalized.startsWith("pragma table_info(pss_")) {
      return toCursor<T>([{ name: "test-double-column" }]);
    }
    if (normalized.startsWith("alter table pss_thread_meta add column ")) {
      const name = normalized.split(" ")[5];
      if (!name || this.#state.threadMetaColumns.has(name)) {
        throw new Error(`duplicate column name: ${name}`);
      }
      this.#state.threadMetaColumns.add(name);
      return toCursor<T>([]);
    }
    if (isSchemaStatement(normalized) || isTransactionStatement(normalized)) {
      return toCursor<T>([]);
    }

    if (normalized === "pragma table_info(pss_scheduled_work)") {
      return toCursor<T>(scheduledWorkTableInfoRows());
    }

    if (isScheduledWorkOffsetQuery(normalized)) {
      return toCursor<T>(
        selectScheduledWorkRowsWithOffset(this.#state, normalized, bindings)
      );
    }

    if (normalized.startsWith("select ")) {
      return toCursor<T>(selectSqlRows(this.#state, normalized, bindings));
    }

    writeSqlStatement(this.#state, normalized, bindings);
    return toCursor<T>([]);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const previous = cloneInMemoryDurableObjectSqlState(this.#state);
    try {
      return await fn();
    } catch (error) {
      this.#state = previous;
      throw error;
    }
  }

  transactionSync<T>(fn: () => T): T {
    const previous = cloneInMemoryDurableObjectSqlState(this.#state);
    try {
      return fn();
    } catch (error) {
      this.#state = previous;
      throw error;
    }
  }
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function isSchemaStatement(query: string): boolean {
  return (
    query.startsWith("create table ") ||
    query.startsWith("alter table ") ||
    query.startsWith("create index ") ||
    query.startsWith("create unique index ")
  );
}

function isTransactionStatement(query: string): boolean {
  return query === "begin" || query === "commit" || query === "rollback";
}

function toCursor<T>(rows: readonly unknown[]): SqlStorageCursorLike<T> {
  const cursorRows = rows as T[];
  return {
    toArray: () => cursorRows,
    [Symbol.iterator]: () => cursorRows[Symbol.iterator](),
  };
}
