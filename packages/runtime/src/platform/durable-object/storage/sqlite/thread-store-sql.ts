// biome-ignore-all lint/performance/noBarrelFile: Stable internal compatibility surface while SQL responsibilities live in focused modules.
export { deleteThreadRows } from "./thread-store-sql/cleanup/delete";
export {
  deleteThreadCompactions,
  readThreadCompactions,
  serializeThreadCompactions,
  writeThreadCompactions,
} from "./thread-store-sql/compactions/retention";
export {
  type RawThreadMessageRow,
  type SerializedThreadCompactionRow,
  type StoredThreadCompactionRecord,
  type ThreadMessageChunkMarker,
  type ThreadMessageChunkRow,
  type ThreadMessageRow,
  type ThreadMetaRow,
  threadRowKey,
  type WriteHistoryRowsOptions,
} from "./thread-store-sql/keys/types";
export {
  readActiveThreadMessages,
  softDeleteActiveThreadRows,
  writeThreadHistoryRows,
} from "./thread-store-sql/messages/history";
export { readThreadMeta, writeThreadMeta } from "./thread-store-sql/meta";
export { ensureThreadSchema } from "./thread-store-sql/schema/bootstrap";
