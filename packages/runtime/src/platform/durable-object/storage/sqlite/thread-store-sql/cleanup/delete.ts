import type { SqlStorage } from "../../../../sql/ports/storage-port";
import { deleteThreadCompactions } from "../compactions/retention";

export function deleteThreadRows(sql: SqlStorage, key: string): void {
  deleteThreadCompactions(sql, key);
  sql.exec("DELETE FROM pss_thread_message_chunk WHERE thread_key = ?", key);
  sql.exec("DELETE FROM pss_thread_message WHERE thread_key = ?", key);
  // Run, event, checkpoint, notification, and scheduled-work cleanup belongs to
  // their adjacent stores; this helper only deletes thread-local tables.
  sql.exec("DELETE FROM pss_thread_meta WHERE thread_key = ?", key);
}
