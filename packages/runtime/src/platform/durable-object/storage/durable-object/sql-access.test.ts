import { describe, expect, it } from "vitest";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import type { DurableObjectStorage } from "./durable-object-storage";
import {
  MissingDurableObjectTransactionError,
  withTransaction,
} from "./sql-access";

describe("Durable Object SQL access", () => {
  it("fails fast when transaction support is missing", async () => {
    await expect(
      withTransaction(new StorageWithoutTransaction(), () =>
        Promise.resolve(undefined)
      )
    ).rejects.toBeInstanceOf(MissingDurableObjectTransactionError);
  });
});

class StorageWithoutTransaction implements DurableObjectStorage {
  readonly sql = new InMemorySqlStorage();

  delete(): Promise<unknown> {
    return Promise.resolve(false);
  }

  get<T>(): Promise<T | undefined> {
    return Promise.resolve(undefined);
  }

  put(): Promise<void> {
    return Promise.resolve();
  }
}
