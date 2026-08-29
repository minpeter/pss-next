import type { SqlStorage } from "../../sql/ports/storage-port";
import { parsePayloadChunkMarker } from "./payload-chunk-markers";
import type { PayloadChunkLocation } from "./payload-chunk-table";

interface PayloadChunkRow {
  readonly chunk: string;
  readonly chunk_index: number;
  readonly payload_key?: string;
}

export interface StoredPayloadRow {
  readonly payloadKey: string;
  readonly storedPayload: string;
}

export function readJsonPayloadFromSqlRows(
  sql: SqlStorage,
  location: PayloadChunkLocation,
  storedPayload: string
): string {
  const marker = parsePayloadChunkMarker(storedPayload);
  if (!marker) {
    return storedPayload;
  }

  const chunks = sql
    .exec<PayloadChunkRow>(
      "SELECT chunk_index, chunk FROM pss_payload_chunk WHERE scope = ? AND owner_key = ? AND payload_key = ? ORDER BY chunk_index",
      location.scope,
      location.ownerKey,
      location.payloadKey
    )
    .toArray();
  if (chunks.length !== marker.n) {
    throw new Error(
      `Missing chunked ${location.scope} payload for ${location.ownerKey} ${location.payloadKey}`
    );
  }
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.chunk_index !== index) {
      throw new Error(
        `Out-of-order chunked ${location.scope} payload for ${location.ownerKey} ${location.payloadKey}`
      );
    }
  }
  return chunks.map((chunk) => chunk.chunk).join("");
}

export function readJsonPayloadsFromSqlRows(
  sql: SqlStorage,
  scope: string,
  ownerKey: string,
  rows: readonly StoredPayloadRow[]
): Map<string, string> {
  const payloads = new Map<string, string>();
  const chunkMarkers = new Map<string, { readonly n: number }>();
  for (const row of rows) {
    const marker = parsePayloadChunkMarker(row.storedPayload);
    if (marker) {
      chunkMarkers.set(row.payloadKey, marker);
    } else {
      payloads.set(row.payloadKey, row.storedPayload);
    }
  }
  if (chunkMarkers.size === 0) {
    return payloads;
  }

  const payloadKeys = [...chunkMarkers.keys()];
  const placeholders = payloadKeys.map(() => "?").join(",");
  const chunks = sql
    .exec<PayloadChunkRow>(
      `SELECT payload_key, chunk_index, chunk FROM pss_payload_chunk WHERE scope = ? AND owner_key = ? AND payload_key IN (${placeholders}) ORDER BY payload_key, chunk_index`,
      scope,
      ownerKey,
      ...payloadKeys
    )
    .toArray();
  const grouped = new Map<string, PayloadChunkRow[]>();
  for (const chunk of chunks) {
    if (chunk.payload_key === undefined) {
      continue;
    }
    const group = grouped.get(chunk.payload_key);
    if (group) {
      group.push(chunk);
    } else {
      grouped.set(chunk.payload_key, [chunk]);
    }
  }
  for (const [payloadKey, marker] of chunkMarkers) {
    const group = grouped.get(payloadKey) ?? [];
    if (group.length !== marker.n) {
      throw new Error(
        `Missing chunked ${scope} payload for ${ownerKey} ${payloadKey}`
      );
    }
    for (const [index, chunk] of group.entries()) {
      if (chunk.chunk_index !== index) {
        throw new Error(
          `Out-of-order chunked ${scope} payload for ${ownerKey} ${payloadKey}`
        );
      }
    }
    payloads.set(payloadKey, group.map((chunk) => chunk.chunk).join(""));
  }
  return payloads;
}
