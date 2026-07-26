import { describe, expect, it } from "vitest";
import { seedAppliedMigrations, ThreadState } from "./thread-state";

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
    setSnapshot(next) {
      stored = structuredClone(next);
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

  it("accepts a reloaded snapshot that already recorded migrations", async () => {
    // Given — concurrent migrator wins the commit race
    const initialState = {
      history: [{ content: "before", role: "user" }],
      schemaVersion: 1,
    };
    const store = createStore(initialState, { conflict: true });
    let applications = 0;
    const state = new ThreadState({
      key: "thread:qa",
      migrations: [
        {
          id: "qa/conflict",
          migrate(snapshot) {
            applications += 1;
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
    // Simulate the concurrent writer applying the migration before our commit.
    store.commit = (key, _next, options) => {
      expect(key).toBe("thread:qa");
      expect(options.expectedVersion).toBe("v1");
      store.setSnapshot({
        state: {
          appliedMigrations: { "qa/conflict": 1 },
          compactions: [],
          history: [{ content: "after", role: "user" }],
          schemaVersion: 3,
        },
        version: "v2",
      });
      return Promise.resolve({ ok: false, reason: "conflict" });
    };

    // When
    await state.ensureLoaded();

    // Then — reloaded winner already has markers; migrate ran only once locally
    expect(applications).toBe(1);
    expect(state.modelSnapshot()).toEqual([{ content: "after", role: "user" }]);
  });

  it("re-applies migrations when a non-migration writer wins the conflict", async () => {
    // Given
    const initialState = {
      history: [{ content: "legacy", role: "user" }],
      schemaVersion: 1,
    };
    let stored = {
      state: structuredClone(initialState),
      version: "v1",
    };
    let commits = 0;
    let applications = 0;
    const store = {
      commit(key, next, options) {
        expect(key).toBe("thread:qa");
        expect(options.expectedVersion).toBe(stored.version);
        commits += 1;
        if (commits === 1) {
          // Non-migration writer bumped version without appliedMigrations.
          stored = {
            state: {
              history: [{ content: "stale-writer", role: "user" }],
              schemaVersion: 1,
            },
            version: "v2",
          };
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
    };

    const state = new ThreadState({
      key: "thread:qa",
      migrations: [
        {
          id: "qa/sanitize",
          migrate(snapshot) {
            applications += 1;
            return {
              ...snapshot,
              history: snapshot.history.map((message) => ({
                ...message,
                content: `migrated:${message.content}`,
              })),
            };
          },
          version: 1,
        },
      ],
      store,
    });

    // When
    await state.ensureLoaded();

    // Then — first attempt + retry after unmigrated winner
    expect(applications).toBe(2);
    expect(commits).toBe(2);
    expect(state.modelSnapshot()).toEqual([
      { content: "migrated:stale-writer", role: "user" },
    ]);
  });

  it("seeds applied migration markers with own properties for special keys", () => {
    // constructor is a valid migration id (matches MIGRATION_ID_PATTERN).
    const applied = seedAppliedMigrations([
      {
        id: "constructor",
        migrate: (snapshot) => snapshot,
        version: 2,
      },
      {
        id: "toString",
        migrate: (snapshot) => snapshot,
        version: 3,
      },
    ]);

    expect(Object.getPrototypeOf(applied)).toBeNull();
    expect(Object.hasOwn(applied, "constructor")).toBe(true);
    expect(Object.hasOwn(applied, "toString")).toBe(true);
    expect(applied.constructor).toBe(2);
    expect(applied.toString).toBe(3);
    expect(Object.keys(applied).sort()).toEqual(["constructor", "toString"]);
  });
});
