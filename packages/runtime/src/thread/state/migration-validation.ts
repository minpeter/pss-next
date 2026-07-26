import type { ThreadStore } from "../store/types";
import {
  applyThreadStateMigrations,
  normalizeThreadStateMigrations,
  type ThreadStateMigration,
} from "./migrations";
import { decodeStoredThreadState } from "./snapshot";

/**
 * Run the configured migrations against a stored thread snapshot without
 * committing anything.
 *
 * Hosts that hot-swap agents (for example the coding-agent `/reload`
 * command) use this to prove that newly registered migrations accept the
 * current durable history before the replacement runtime goes live. Throws
 * `ThreadMigrationError` when a migration rejects the snapshot; resolves
 * without side effects otherwise.
 */
export async function validateThreadStateMigrations({
  migrations,
  store,
  threadKey,
}: {
  readonly migrations: readonly ThreadStateMigration[];
  readonly store: Pick<ThreadStore, "load">;
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
  await applyThreadStateMigrations({
    migrations: normalized,
    state: decodeStoredThreadState(stored),
    threadKey,
  });
}
