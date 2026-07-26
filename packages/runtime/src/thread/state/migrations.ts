import type { ModelMessage } from "ai";
import {
  type DecodedThreadState,
  decodeStoredThreadState,
  encodeThreadSnapshot,
  type ThreadCompactionRecord,
} from "./snapshot";

const MIGRATION_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/;

export interface ThreadMigrationSnapshot {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly history: readonly ModelMessage[];
}

export interface ThreadMigrationContext {
  readonly threadKey: string;
}

export interface ThreadStateMigration {
  readonly id: string;
  readonly migrate: (
    snapshot: ThreadMigrationSnapshot,
    context: ThreadMigrationContext
  ) => Promise<ThreadMigrationSnapshot> | ThreadMigrationSnapshot;
  readonly version: number;
}

export class ThreadMigrationError extends Error {
  readonly migrationId: string;
  readonly threadKey: string;

  constructor(migrationId: string, threadKey: string, cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`Thread migration "${migrationId}" failed${detail}`, { cause });
    this.name = "ThreadMigrationError";
    this.migrationId = migrationId;
    this.threadKey = threadKey;
  }
}

export interface AppliedThreadMigrations {
  readonly [migrationId: string]: number;
}

export interface ThreadMigrationResult extends DecodedThreadState {
  readonly changed: boolean;
}

export function normalizeThreadStateMigrations(
  migrations: readonly ThreadStateMigration[] | undefined
): readonly ThreadStateMigration[] {
  if (migrations === undefined) {
    return [];
  }
  const ids = new Set<string>();
  return migrations.map((migration) => {
    if (!MIGRATION_ID_PATTERN.test(migration.id)) {
      throw new TypeError(`Invalid thread migration id: ${migration.id}`);
    }
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new TypeError(
        `Thread migration "${migration.id}" version must be a positive integer`
      );
    }
    if (typeof migration.migrate !== "function") {
      throw new TypeError(
        `Thread migration "${migration.id}" migrate must be a function`
      );
    }
    if (ids.has(migration.id)) {
      throw new TypeError(`Duplicate thread migration id: ${migration.id}`);
    }
    ids.add(migration.id);
    return migration;
  });
}

export async function applyThreadStateMigrations({
  migrations,
  state,
  threadKey,
}: {
  readonly migrations: readonly ThreadStateMigration[];
  readonly state: DecodedThreadState;
  readonly threadKey: string;
}): Promise<ThreadMigrationResult> {
  let current = state;
  let changed = false;
  for (const migration of migrations) {
    if ((current.appliedMigrations[migration.id] ?? 0) >= migration.version) {
      continue;
    }
    let output: ThreadMigrationSnapshot;
    try {
      output = await migration.migrate(
        structuredClone({
          compactions: current.compactions,
          history: current.history,
        }),
        { threadKey }
      );
    } catch (error) {
      throw new ThreadMigrationError(migration.id, threadKey, error);
    }
    const appliedMigrations = {
      ...current.appliedMigrations,
      [migration.id]: migration.version,
    };
    try {
      current = decodeStoredThreadState({
        state: encodeThreadSnapshot(
          output.history,
          output.compactions,
          appliedMigrations
        ),
        version: "migration-validation",
      });
    } catch (error) {
      throw new ThreadMigrationError(migration.id, threadKey, error);
    }
    changed = true;
  }
  return { ...current, changed };
}
