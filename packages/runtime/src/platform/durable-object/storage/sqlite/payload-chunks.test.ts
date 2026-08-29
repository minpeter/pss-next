import { describe, expect, it } from "vitest";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { readJsonPayloadFromSqlRows } from "./payload-chunk-read";
import { ensurePayloadChunkSchema } from "./payload-chunk-table";
import { writeJsonPayloadToSqlRows } from "./payload-chunk-write";

describe("payload chunk rows", () => {
  it("deletes stale chunks when a payload is rewritten inline", () => {
    const sql = new InMemorySqlStorage();
    const location = {
      ownerKey: "owner",
      payloadKey: "payload",
      scope: "notification",
    };
    ensurePayloadChunkSchema(sql);

    const largeMarker = writeJsonPayloadToSqlRows(
      sql,
      location,
      "notification-record",
      { text: "큰 payload ".repeat(80) },
      220
    );
    expect(chunkCount(sql)).toBeGreaterThan(0);

    const inline = writeJsonPayloadToSqlRows(
      sql,
      location,
      "notification-record",
      { text: "small" },
      220
    );

    expect(inline).toBe(JSON.stringify({ text: "small" }));
    expect(inline).not.toBe(largeMarker);
    expect(chunkCount(sql)).toBe(0);
    expect(readJsonPayloadFromSqlRows(sql, location, inline)).toBe(inline);
  });
});

function chunkCount(sql: InMemorySqlStorage): number {
  const [row] = sql
    .exec<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM pss_payload_chunk"
    )
    .toArray();
  return row?.count ?? 0;
}
