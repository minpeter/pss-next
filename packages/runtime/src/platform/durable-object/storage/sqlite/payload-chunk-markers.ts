import {
  type StoragePayloadKind,
  StoragePayloadTooLargeError,
  serializedJsonByteLength,
} from "../payload-guard";

const payloadChunkMarkerPrefix = "\u001epss-payload-chunk:";

export function parsePayloadChunkMarker(
  payload: string
): { readonly n: number } | null {
  if (!payload.startsWith(payloadChunkMarkerPrefix)) {
    return null;
  }
  const count = Number(payload.slice(payloadChunkMarkerPrefix.length));
  return Number.isInteger(count) && count > 0 ? { n: count } : null;
}

export function createPayloadChunkMarker(
  payloadKind: StoragePayloadKind,
  chunkCount: number,
  maxPayloadBytes: number
): string {
  const marker = `${payloadChunkMarkerPrefix}${chunkCount}`;
  const byteLength = serializedJsonByteLength(marker);
  if (byteLength > maxPayloadBytes) {
    throw new StoragePayloadTooLargeError({
      byteLength,
      maxBytes: maxPayloadBytes,
      payloadKind,
    });
  }
  return marker;
}
