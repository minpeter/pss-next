import type { ThreadCompactionRecord } from "../../../../../../thread/state/snapshot";
import type { SqlStorage } from "../../../../sql/ports/storage-port";
import { stringifyJsonPayloadWithinBudget } from "../../../payload-guard";
import type {
  SerializedThreadCompactionRow,
  StoredThreadCompactionRecord,
} from "../keys/types";

export function readThreadCompactions(
  sql: SqlStorage,
  key: string
): StoredThreadCompactionRecord[] {
  const rows = sql
    .exec<{
      end_seq_exclusive: number;
      start_seq: number;
      summary: string;
    }>(
      "SELECT start_seq, end_seq_exclusive, summary FROM pss_thread_compaction WHERE thread_key = ? ORDER BY ordinal",
      key
    )
    .toArray();

  return rows.map((row) => {
    const summary: unknown = JSON.parse(row.summary);
    return {
      endSeqExclusive: row.end_seq_exclusive,
      schemaVersion: 1,
      startSeq: row.start_seq,
      summary,
    };
  });
}

export function serializeThreadCompactions(
  compactions: readonly ThreadCompactionRecord[],
  maxPayloadBytes: number
): SerializedThreadCompactionRow[] {
  return compactions.map((record, ordinal) => ({
    endSeqExclusive: record.endSeqExclusive,
    ordinal,
    startSeq: record.startSeq,
    summary: stringifyJsonPayloadWithinBudget(
      "thread-compaction",
      record.summary,
      maxPayloadBytes
    ),
  }));
}

export function writeThreadCompactions(
  sql: SqlStorage,
  key: string,
  rows: readonly SerializedThreadCompactionRow[]
): void {
  deleteThreadCompactions(sql, key);
  for (const row of rows) {
    sql.exec(
      "INSERT INTO pss_thread_compaction (thread_key, ordinal, start_seq, end_seq_exclusive, summary) VALUES (?, ?, ?, ?, ?)",
      key,
      row.ordinal,
      row.startSeq,
      row.endSeqExclusive,
      row.summary
    );
  }
}

export function deleteThreadCompactions(sql: SqlStorage, key: string): void {
  sql.exec("DELETE FROM pss_thread_compaction WHERE thread_key = ?", key);
}
