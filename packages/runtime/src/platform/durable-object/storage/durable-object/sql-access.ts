import type { SqlStorage } from "../../sql/ports/storage-port";
import {
  type DurableObjectStorage,
  type DurableObjectTransactionStorage,
  isSqlStorage,
  withSqlStorage,
} from "./durable-object-storage";

export async function withTransaction<T>(
  storage: DurableObjectStorage,
  fn: (storage: DurableObjectTransactionStorage) => Promise<T>
): Promise<T> {
  if (storage.transaction === undefined) {
    throw new MissingDurableObjectTransactionError();
  }
  return await storage.transaction((tx) =>
    fn(tx.sql === undefined ? withSqlStorage(tx, storage.sql) : tx)
  );
}

export class MissingDurableObjectTransactionError extends Error {
  constructor() {
    super("Durable Object storage transaction() is required.");
    this.name = "MissingDurableObjectTransactionError";
  }
}

export function requiredSqlStorage(
  storage: DurableObjectTransactionStorage,
  requirer: string
): SqlStorage {
  const sql = storage.sql;
  if (isSqlStorage(sql)) {
    return sql;
  }
  throw new Error(`${requirer} requires SQLite storage.`);
}
