import { describe, expect, it } from "vitest";
import type {
  CommitResult,
  StoredThread,
  ThreadStoreCommit,
} from "../store/types";
import { commitThreadStateMigrations } from "./migration-validation";
import {
  ThreadMigrationError,
  type ThreadMigrationSnapshot,
} from "./migrations";

const conflictPattern = /changed while committing migrations/u;

function storeWith(
  stored: StoredThread | null,
  commitResult: CommitResult = { ok: true, version: "v2" }
): {
  commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult>;
  readonly commits: {
    readonly expectedVersion: string | null;
    readonly state: unknown;
  }[];
  load(key: string): Promise<StoredThread | null>;
  readonly loads: string[];
} {
  const loads: string[] = [];
  const commits: { expectedVersion: string | null; state: unknown }[] = [];
  return {
    commit: (_key, next, options) => {
      commits.push({
        expectedVersion: options.expectedVersion,
        state: next.state,
      });
      return Promise.resolve(commitResult);
    },
    commits,
    load: (key) => {
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

describe("commitThreadStateMigrations", () => {
  it("skips loading when no migrations are configured", async () => {
    // Given
    const store = storeWith(storedThread);

    // When
    await commitThreadStateMigrations({
      migrations: [],
      store,
      threadKey: "thread-1",
    });

    // Then
    expect(store.loads).toEqual([]);
    expect(store.commits).toEqual([]);
  });

  it("commits migrated state with applied markers exactly once", async () => {
    // Given
    const store = storeWith(storedThread);
    const runs: unknown[] = [];
    const migration = {
      id: "sanitize",
      migrate: (snapshot: ThreadMigrationSnapshot) => {
        runs.push(snapshot);
        return {
          compactions: snapshot.compactions,
          history: [{ content: "sanitized", role: "user" as const }],
        };
      },
      version: 1,
    };

    // When
    const committed = await commitThreadStateMigrations({
      migrations: [migration],
      store,
      threadKey: "thread-1",
    });

    // Then
    expect(runs).toHaveLength(1);
    expect(store.commits).toHaveLength(1);
    expect(store.commits[0]?.expectedVersion).toBe("v1");
    expect(store.commits[0]?.state).toMatchObject({
      appliedMigrations: { sanitize: 1 },
      history: [{ content: "sanitized", role: "user" }],
    });

    // When — reverting restores the pre-migration snapshot.
    await committed?.revert();

    // Then
    expect(store.commits).toHaveLength(2);
    expect(store.commits[1]?.expectedVersion).toBe("v2");
    expect(store.commits[1]?.state).toBe(storedThread.state);
  });

  it("does not commit when nothing changes or the thread is missing", async () => {
    // Given
    const empty = storeWith(null);
    const alreadyApplied = storeWith({
      state: {
        appliedMigrations: { sanitize: 1 },
        compactions: [],
        history: [],
        schemaVersion: 3,
      },
      version: "v3",
    });
    const migration = {
      id: "sanitize",
      migrate: (snapshot: ThreadMigrationSnapshot) => snapshot,
      version: 1,
    };

    // When
    await commitThreadStateMigrations({
      migrations: [migration],
      store: empty,
      threadKey: "thread-1",
    });
    await commitThreadStateMigrations({
      migrations: [migration],
      store: alreadyApplied,
      threadKey: "thread-1",
    });

    // Then
    expect(empty.commits).toEqual([]);
    expect(alreadyApplied.commits).toEqual([]);
  });

  it("returns no revert handle when nothing was committed", async () => {
    // Given
    const store = storeWith(null);

    // When
    const committed = await commitThreadStateMigrations({
      migrations: [
        {
          id: "sanitize",
          migrate: (snapshot: ThreadMigrationSnapshot) => snapshot,
          version: 1,
        },
      ],
      store,
      threadKey: "thread-1",
    });

    // Then
    expect(committed).toBeUndefined();
  });

  it("surfaces rejecting migrations and commit conflicts", async () => {
    // Given
    const store = storeWith(storedThread);
    const conflicted = storeWith(storedThread, {
      ok: false,
      reason: "conflict",
    });
    const passing = {
      id: "pass",
      migrate: (snapshot: ThreadMigrationSnapshot) => ({
        compactions: snapshot.compactions,
        history: [],
      }),
      version: 1,
    };

    // When / Then
    await expect(
      commitThreadStateMigrations({
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
    await expect(
      commitThreadStateMigrations({
        migrations: [passing],
        store: conflicted,
        threadKey: "thread-1",
      })
    ).rejects.toThrow(conflictPattern);
  });
});
