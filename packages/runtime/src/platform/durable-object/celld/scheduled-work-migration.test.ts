import { describe, expect, it } from "vitest";
import { ensureScheduledWorkSchema } from "../storage/sqlite/scheduled-work-table-schema";
import { createCelldSqliteTestStorage } from "./celld-sqlite-test-storage";

const ADDITIVE_COLUMNS = [
  "claim_token",
  "claimed_until",
  "due_at",
  "run_id",
  "thread_key",
] as const;
const SCHEDULER_INDEXES = [
  "pss_scheduled_work_celld_due",
  "pss_scheduled_work_due",
  "pss_scheduled_work_key",
  "pss_scheduled_work_run",
  "pss_scheduled_work_thread",
] as const;
const ADDITIVE_COLUMN_NAMES: ReadonlySet<string> = new Set(ADDITIVE_COLUMNS);
const SCHEDULER_INDEX_NAMES: ReadonlySet<string> = new Set(SCHEDULER_INDEXES);

describe("scheduled work SQLite migration", () => {
  it("adds scheduler columns and indexes to a real legacy SQLite table idempotently", () => {
    // Given
    const storage = createCelldSqliteTestStorage();
    storage.sql.exec(
      "CREATE TABLE pss_scheduled_work (prefix TEXT NOT NULL, kind TEXT NOT NULL, work_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (prefix, kind, work_id))"
    );
    storage.sql.exec(
      "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      "legacy",
      "scheduled-run",
      "run-1",
      JSON.stringify("run-1"),
      7
    );

    // When
    ensureScheduledWorkSchema(storage.sql);
    ensureScheduledWorkSchema(storage.sql);

    // Then
    const columns = storage.sql
      .exec<{ readonly name: string }>("PRAGMA table_info(pss_scheduled_work)")
      .toArray()
      .map((column) => column.name);
    const indexes = storage.sql
      .exec<{ readonly name: string }>("PRAGMA index_list(pss_scheduled_work)")
      .toArray()
      .map((index) => index.name);
    expect(
      columns.filter((column) => ADDITIVE_COLUMN_NAMES.has(column)).sort()
    ).toEqual(ADDITIVE_COLUMNS);
    expect(
      indexes.filter((index) => SCHEDULER_INDEX_NAMES.has(index)).sort()
    ).toEqual(SCHEDULER_INDEXES);
    expect(
      storage.sql
        .exec<{ readonly work_id: string }>(
          "SELECT work_id FROM pss_scheduled_work WHERE prefix = ?",
          "legacy"
        )
        .toArray()
    ).toEqual([{ work_id: "run-1" }]);
  });
});
