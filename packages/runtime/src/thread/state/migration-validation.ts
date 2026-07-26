import type { ThreadStore } from "../store/types";
import {
  applyThreadStateMigrations,
  normalizeThreadStateMigrations,
  type ThreadStateMigration,
} from "./migrations";
import { decodeStoredThreadState, encodeThreadSnapshot } from "./snapshot";

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
 * Throws `ThreadMigrationError` when a migration rejects the snapshot and a
 * plain `Error` when a concurrent writer wins the commit; resolves without
 * writing when no migration changes the snapshot.
 */
export async function commitThreadStateMigrations({
  migrations,
  store,
  threadKey,
}: {
  readonly migrations: readonly ThreadStateMigration[];
  readonly store: Pick<ThreadStore, "commit" | "load">;
  readonly threadKey: string;
}): Promise<void> {
  const normalized = normalizeThreadStateMigrations(migrations);
  if (normalized.length === 0) {
    return;
  }
  const stored = await store.load(threadKey);
  if (stored === null) {
    return;
  }
  const migrated = await applyThreadStateMigrations({
    migrations: normalized,
    state: decodeStoredThreadState(stored),
    threadKey,
  });
  if (!migrated.changed) {
    return;
  }
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
}
