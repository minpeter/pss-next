import { describe, expect, it } from "vitest";
import type { StoredThread } from "../store/types";
import { validateThreadStateMigrations } from "./migration-validation";
import { ThreadMigrationError } from "./migrations";

function storeWith(stored: StoredThread | null): {
  load(key: string): Promise<StoredThread | null>;
  readonly loads: string[];
} {
  const loads: string[] = [];
  return {
    load: (key: string) => {
      loads.push(key);
      return Promise.resolve(stored);
    },
    loads,
  };
}

const storedThread: StoredThread = {
  state: {
    history: [{ content: "hello", role: "user" }],
    schemaVersion: 1,
  },
  version: "v1",
};

describe("validateThreadStateMigrations", () => {
  it("skips loading when no migrations are configured", async () => {
    // Given
    const store = storeWith(storedThread);

    // When
    await validateThreadStateMigrations({
      migrations: [],
      store,
      threadKey: "thread-1",
    });

    // Then
    expect(store.loads).toEqual([]);
  });

  it("accepts missing threads and passing migrations without committing", async () => {
    // Given
    const empty = storeWith(null);
    const store = storeWith(storedThread);
    const seen: unknown[] = [];
    const migration = {
      id: "sanitize",
      migrate: (snapshot: unknown) => {
        seen.push(snapshot);
        return snapshot as never;
      },
      version: 1,
    };

    // When
    await validateThreadStateMigrations({
      migrations: [migration],
      store: empty,
      threadKey: "thread-1",
    });
    await validateThreadStateMigrations({
      migrations: [migration],
      store,
      threadKey: "thread-1",
    });

    // Then
    expect(empty.loads).toEqual(["thread-1"]);
    expect(store.loads).toEqual(["thread-1"]);
    expect(seen).toHaveLength(1);
  });

  it("surfaces rejecting migrations as ThreadMigrationError", async () => {
    // Given
    const store = storeWith(storedThread);

    // When / Then
    await expect(
      validateThreadStateMigrations({
        migrations: [
          {
            id: "rejects",
            migrate: () => {
              throw new Error("history not supported");
            },
            version: 1,
          },
        ],
        store,
        threadKey: "thread-1",
      })
    ).rejects.toBeInstanceOf(ThreadMigrationError);
  });
});
