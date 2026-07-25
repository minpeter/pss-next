import type { SqlStorage } from "../../../../sql/ports/storage-port";

export function ensureThreadSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_thread_message (thread_key TEXT NOT NULL, seq INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, message TEXT NOT NULL, PRIMARY KEY (thread_key, seq))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_thread_message_active ON pss_thread_message (thread_key, active, seq)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_thread_meta (thread_key TEXT PRIMARY KEY, version TEXT NOT NULL, message_count INTEGER NOT NULL, next_seq INTEGER NOT NULL, state_blob TEXT, applied_migrations TEXT)"
  );
  try {
    sql.exec("ALTER TABLE pss_thread_meta ADD COLUMN applied_migrations TEXT");
  } catch {
    // Column already exists on stores created before schemaVersion 3 support.
  }
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_thread_message_chunk (thread_key TEXT NOT NULL, seq INTEGER NOT NULL, chunk_index INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY (thread_key, seq, chunk_index))"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_thread_compaction (thread_key TEXT NOT NULL, ordinal INTEGER NOT NULL, start_seq INTEGER NOT NULL, end_seq_exclusive INTEGER NOT NULL, summary TEXT NOT NULL, PRIMARY KEY (thread_key, ordinal))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_thread_compaction_range ON pss_thread_compaction (thread_key, start_seq, end_seq_exclusive)"
  );
}
