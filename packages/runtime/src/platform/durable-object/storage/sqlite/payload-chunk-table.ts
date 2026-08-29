import type { SqlStorage } from "../../sql/ports/storage-port";

export interface PayloadChunkLocation {
  readonly ownerKey: string;
  readonly payloadKey: string;
  readonly scope: string;
}

export function ensurePayloadChunkSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_payload_chunk (scope TEXT NOT NULL, owner_key TEXT NOT NULL, payload_key TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY (scope, owner_key, payload_key, chunk_index))"
  );
}

export function deletePayloadChunks(
  sql: SqlStorage,
  location: PayloadChunkLocation
): void {
  sql.exec(
    "DELETE FROM pss_payload_chunk WHERE scope = ? AND owner_key = ? AND payload_key = ?",
    location.scope,
    location.ownerKey,
    location.payloadKey
  );
}
