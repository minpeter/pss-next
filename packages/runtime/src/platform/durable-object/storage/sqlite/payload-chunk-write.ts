import type { SqlStorage } from "../../sql/ports/storage-port";
import {
  type StoragePayloadKind,
  StoragePayloadSerializationError,
  serializedJsonByteLength,
} from "../payload-guard";
import { createPayloadChunkMarker } from "./payload-chunk-markers";
import {
  deletePayloadChunks,
  type PayloadChunkLocation,
} from "./payload-chunk-table";

const textEncoder = new TextEncoder();

export function writeJsonPayloadToSqlRows(
  sql: SqlStorage,
  location: PayloadChunkLocation,
  payloadKind: StoragePayloadKind,
  value: unknown,
  maxPayloadBytes: number
): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new StoragePayloadSerializationError(payloadKind);
  }

  deletePayloadChunks(sql, location);
  if (serializedJsonByteLength(serialized) <= maxPayloadBytes) {
    return serialized;
  }

  const chunks = chunkSerializedPayload(serialized, maxPayloadBytes);
  const marker = createPayloadChunkMarker(
    payloadKind,
    chunks.length,
    maxPayloadBytes
  );
  for (const [index, chunk] of chunks.entries()) {
    sql.exec(
      "INSERT INTO pss_payload_chunk (scope, owner_key, payload_key, chunk_index, chunk) VALUES (?, ?, ?, ?, ?)",
      location.scope,
      location.ownerKey,
      location.payloadKey,
      index,
      chunk
    );
  }
  return marker;
}

function chunkSerializedPayload(
  serialized: string,
  maxPayloadBytes: number
): string[] {
  const chunkMaxBytes = Math.max(1, maxPayloadBytes);
  const totalBytes = textEncoder.encode(serialized).byteLength;
  if (totalBytes <= chunkMaxBytes) {
    return [serialized];
  }
  if (totalBytes === serialized.length) {
    const chunks: string[] = [];
    for (let index = 0; index < serialized.length; index += chunkMaxBytes) {
      chunks.push(serialized.slice(index, index + chunkMaxBytes));
    }
    return chunks;
  }

  const chunks: string[] = [];
  let currentStart = 0;
  while (currentStart < serialized.length) {
    const firstEnd = nextCodePointEnd(serialized, currentStart);
    let low = firstEnd;
    let high = Math.max(
      firstEnd,
      Math.min(serialized.length, currentStart + chunkMaxBytes)
    );
    let best = firstEnd;
    while (low <= high) {
      const mid = avoidTrailingHighSurrogate(
        serialized,
        Math.floor((low + high) / 2)
      );
      if (mid <= currentStart) {
        break;
      }
      const byteLength = textEncoder.encode(
        serialized.slice(currentStart, mid)
      ).byteLength;
      if (byteLength <= chunkMaxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    chunks.push(serialized.slice(currentStart, best));
    currentStart = best;
  }
  return chunks;
}

function avoidTrailingHighSurrogate(value: string, index: number): number {
  if (index <= 0 || index >= value.length) {
    return index;
  }
  const previous = value.charCodeAt(index - 1);
  return previous >= 0xd8_00 && previous <= 0xdb_ff ? index - 1 : index;
}

function nextCodePointEnd(value: string, index: number): number {
  if (index >= value.length) {
    return index;
  }
  const first = value.charCodeAt(index);
  const second = value.charCodeAt(index + 1);
  return first >= 0xd8_00 &&
    first <= 0xdb_ff &&
    second >= 0xdc_00 &&
    second <= 0xdf_ff
    ? index + 2
    : index + 1;
}
