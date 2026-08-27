import { describe, expect, it } from "vitest";
import { runMatrix } from "./qa-matrix";

describe("Celld QA matrix", () => {
  it("proves malformed, duplicate, and concurrent behavior", async () => {
    await expect(
      runMatrix({
        baseUrl: "http://127.0.0.1:16421",
        objectCount: 25,
        concurrency: 64,
        fetchImpl: createFakeFetch(),
      })
    ).resolves.toMatchObject({
      malformedStatus: 400,
      duplicateCommits: 1,
      concurrentObjects: 25,
    });
  });
});

function createFakeFetch(): typeof fetch {
  const committed = new Map<string, number>();
  let nextKey = 0;
  return (input, init) => {
    if (init?.body === "{") {
      return Promise.resolve(
        Response.json({ error: "malformed_json" }, { status: 400 })
      );
    }
    const payload = parsePayload(init?.body);
    const objectName = new URL(String(input)).searchParams.get("object");
    const key = `${objectName}:${payload.idempotencyKey ?? `object-${nextKey++}`}`;
    const count = committed.get(key);
    if (count !== undefined) {
      return Promise.resolve(
        Response.json({
          commitCount: 1,
          historyCount: count,
          ok: true,
          reply: `echo:${payload.text}`,
        })
      );
    }
    committed.set(key, 1);
    return Promise.resolve(
      Response.json({
        commitCount: 1,
        historyCount: 1,
        ok: true,
        reply: `echo:${payload.text}`,
      })
    );
  };
}

function parsePayload(value: BodyInit | null | undefined): {
  readonly idempotencyKey?: string;
  readonly text: string;
} {
  const parsed: unknown = JSON.parse(String(value));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("text" in parsed) ||
    typeof parsed.text !== "string"
  ) {
    throw new Error("invalid fake payload");
  }
  return {
    ...("idempotencyKey" in parsed && typeof parsed.idempotencyKey === "string"
      ? { idempotencyKey: parsed.idempotencyKey }
      : {}),
    text: parsed.text,
  };
}
