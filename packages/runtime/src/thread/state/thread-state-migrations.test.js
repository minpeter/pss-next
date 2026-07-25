import { describe, expect, it } from "vitest";
import { ThreadState } from "./thread-state";

function createStore(initialState, { conflict = false } = {}) {
  let stored = {
    state: structuredClone(initialState),
    version: "v1",
  };
  let commits = 0;
  return {
    get commits() {
      return commits;
    },
    commit(key, next, options) {
      expect(key).toBe("thread:qa");
      expect(options.expectedVersion).toBe(stored.version);
      commits += 1;
      if (conflict) {
        return Promise.resolve({ ok: false, reason: "conflict" });
      }
      stored = {
        state: structuredClone(next.state),
        version: `v${commits + 1}`,
      };
      return Promise.resolve({ ok: true, version: stored.version });
    },
    delete() {
      return Promise.resolve();
    },
    load() {
      return Promise.resolve(structuredClone(stored));
    },
    snapshot() {
      return structuredClone(stored);
    },
  };
}

describe("persisted thread migrations", () => {
  it("commits a versioned history migration once across reloads", async () => {
    // Given
    const store = createStore({
      history: [{ content: "SECRET", role: "user" }],
      schemaVersion: 1,
    });
    let applications = 0;
    const migration = {
      id: "qa/sanitize-secret",
      migrate(snapshot, context) {
        applications += 1;
        expect(context.threadKey).toBe("thread:qa");
        return {
          ...snapshot,
          history: snapshot.history.map((message) => ({
            ...message,
            content:
              message.content === "SECRET" ? "[redacted]" : message.content,
          })),
        };
      },
      version: 1,
    };

    // When
    const first = new ThreadState({
      key: "thread:qa",
      migrations: [migration],
      store,
    });
    await first.ensureLoaded();
    const second = new ThreadState({
      key: "thread:qa",
      migrations: [migration],
      store,
    });
    await second.ensureLoaded();

    // Then
    expect(first.modelSnapshot()).toEqual([
      { content: "[redacted]", role: "user" },
    ]);
    expect(second.modelSnapshot()).toEqual(first.modelSnapshot());
    expect(applications).toBe(1);
    expect(store.commits).toBe(1);
    expect(store.snapshot().state).toEqual({
      appliedMigrations: { "qa/sanitize-secret": 1 },
      compactions: [],
      history: [{ content: "[redacted]", role: "user" }],
      schemaVersion: 3,
    });
  });

  it("does not expose or persist partial state when a migration throws", async () => {
    // Given
    const initialState = {
      history: [{ content: "SECRET", role: "user" }],
      schemaVersion: 1,
    };
    const store = createStore(initialState);
    const state = new ThreadState({
      key: "thread:qa",
      migrations: [
        {
          id: "qa/failure",
          migrate() {
            throw new Error("migration failed");
          },
          version: 1,
        },
      ],
      store,
    });

    // When
    const loading = state.ensureLoaded();

    // Then
    await expect(loading).rejects.toThrow("migration failed");
    expect(state.modelSnapshot()).toEqual([]);
    expect(store.commits).toBe(0);
    expect(store.snapshot().state).toEqual(initialState);
  });

  it("reloads the migrated snapshot instead of surfacing a spurious optimistic conflict", async () => {
    // Given
    const initialState = {
      history: [{ content: "before", role: "user" }],
      schemaVersion: 1,
    };
    const store = createStore(initialState, { conflict: true });
    const state = new ThreadState({
      key: "thread:qa",
      migrations: [
        {
          id: "qa/conflict",
          migrate(snapshot) {
            return {
              ...snapshot,
              history: [{ content: "after", role: "user" }],
            };
          },
          version: 1,
        },
      ],
      store,
    });

    // When
    const loading = state.ensureLoaded();

    // Then
    await expect(loading).resolves.toBeUndefined();
    expect(state.modelSnapshot()).toEqual([
      { content: "before", role: "user" },
    ]);
    expect(store.commits).toBe(1);
    expect(store.snapshot().state).toEqual(initialState);
  });
});
