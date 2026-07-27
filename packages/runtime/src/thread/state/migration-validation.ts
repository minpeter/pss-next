import type { ThreadStore } from "../store/types";
import {
  applyThreadStateMigrations,
  normalizeThreadStateMigrations,
  type ThreadStateMigration,
} from "./migrations";
import { decodeStoredThreadState, encodeThreadSnapshot } from "./snapshot";

export interface CommittedThreadMigrations {
  /**
   * Restore the pre-migration snapshot. Hosts call this when the runtime
   * swap fails after the commit so the surviving runtime resumes against
   * the history it was built for and a corrected retry re-runs the
   * migration instead of skipping its applied-version marker.
   */
  revert(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

/**
 * Run the configured migrations against a stored thread snapshot and commit
 * the migrated state, preserving exactly-once semantics.
 *
 * Hosts that hot-swap agents (for example the coding-agent `/reload`
 * command) use this to prove that newly registered migrations accept the
 * current durable history before the replacement runtime goes live. Because
 * the migrated snapshot is committed together with its applied-version
 * markers, migration callbacks never re-run on the next thread load; a
 * dry-run would execute stateful migrations twice.
 *
 * Returns a revert handle when a migration changed the snapshot and
 * `undefined` otherwise. Throws `ThreadMigrationError` when a migration
 * rejects the snapshot and a plain `Error` when a concurrent writer wins
 * the commit.
 */
export async function commitThreadStateMigrations({
  migrations,
  signal,
  store,
  threadKey,
  timeoutMs,
}: {
  readonly migrations: readonly ThreadStateMigration[];
  /**
   * Checked immediately before each durable write. Hosts abort the signal
   * when they stop waiting so a detached migration task can never commit
   * after its reload already failed.
   */
  readonly signal?: AbortSignal;
  readonly store: Pick<ThreadStore, "commit" | "load">;
  readonly threadKey: string;
  /**
   * Bounds migration callback execution only. The durable commit itself is
   * intentionally unbounded: once every callback settled inside the budget
   * the write is awaited to completion, so the reported outcome always
   * matches the stored state and a timed-out validation can never commit
   * in the background after failure was reported.
   */
  readonly timeoutMs?: number;
}): Promise<CommittedThreadMigrations | undefined> {
  const normalized = normalizeThreadStateMigrations(migrations);
  if (normalized.length === 0) {
    return;
  }
  const stored = await store.load(threadKey);
  if (stored === null) {
    return;
  }
  const migrated = await boundedMigrationRun(
    applyThreadStateMigrations({
      migrations: normalized,
      state: decodeStoredThreadState(stored),
      threadKey,
    }),
    threadKey,
    timeoutMs
  );
  if (!migrated.changed) {
    return;
  }
  assertNotAborted(signal, threadKey, "committing");
  const result = await store.commit(
    threadKey,
    {
      state: encodeThreadSnapshot(
        migrated.history,
        migrated.compactions,
        migrated.appliedMigrations
      ),
    },
    { expectedVersion: stored.version }
  );
  if (!result.ok) {
    throw new Error(
      `Thread "${threadKey}" changed while committing migrations; retry the operation`
    );
  }
  const committedVersion = result.version;
  return {
    revert: async (options?: { readonly signal?: AbortSignal }) => {
      assertNotAborted(options?.signal, threadKey, "reverting");
      const restored = await store.commit(
        threadKey,
        { state: stored.state },
        { expectedVersion: committedVersion }
      );
      if (!restored.ok) {
        throw new Error(
          `Thread "${threadKey}" changed while reverting migrations; manual inspection required`
        );
      }
    },
  };
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  threadKey: string,
  phase: string
): void {
  if (signal?.aborted) {
    throw new Error(
      `Thread "${threadKey}" migration was aborted before ${phase}; no state was written`
    );
  }
}

function boundedMigrationRun<Value>(
  task: Promise<Value>,
  threadKey: string,
  timeoutMs: number | undefined
): Promise<Value> {
  if (timeoutMs === undefined) {
    return task;
  }
  task.catch(() => undefined);
  return new Promise<Value>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(
        new Error(
          `Thread "${threadKey}" migrations did not settle within ${timeoutMs}ms; no state was written`
        )
      );
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    );
  });
}
