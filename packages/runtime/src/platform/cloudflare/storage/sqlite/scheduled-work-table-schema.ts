import type { SqlStorage } from "../../sql/ports/storage-port";

export function ensureScheduledWorkSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_scheduled_work (prefix TEXT NOT NULL, kind TEXT NOT NULL, work_id TEXT NOT NULL, payload TEXT NOT NULL, thread_key TEXT, run_id TEXT, created_at INTEGER NOT NULL)"
  );
  ensureScheduledWorkColumn(sql, "thread_key");
  ensureScheduledWorkColumn(sql, "run_id");
  ensureScheduledWorkColumn(sql, "claim_token");
  ensureScheduledWorkColumn(sql, "claimed_until");
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS pss_scheduled_work_key ON pss_scheduled_work (prefix, kind, work_id)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_due ON pss_scheduled_work (prefix, kind, created_at, work_id)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_thread ON pss_scheduled_work (prefix, thread_key)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_run ON pss_scheduled_work (prefix, run_id)"
  );
}

export function hasScheduledWorkColumn(
  sql: SqlStorage,
  column: string
): boolean {
  return sql
    .exec<{ readonly name: string }>("PRAGMA table_info(pss_scheduled_work)")
    .toArray()
    .some((row) => row.name === column);
}

function ensureScheduledWorkColumn(sql: SqlStorage, column: string): void {
  if (hasScheduledWorkColumn(sql, column)) {
    return;
  }
  sql.exec(
    `ALTER TABLE pss_scheduled_work ADD COLUMN ${column} ${
      column === "claimed_until" ? "INTEGER" : "TEXT"
    }`
  );
}
