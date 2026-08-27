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

  it("rejects concurrent objects sharing one state history", async () => {
    await expect(
      runMatrix({
        baseUrl: "http://127.0.0.1:16421",
        concurrency: 2,
        fetchImpl: createFakeFetch(false),
        objectCount: 2,
      })
    ).rejects.toThrow("concurrent objects did not preserve isolation");
  });
});

function createFakeFetch(isolated = true): typeof fetch {
  const committed = new Map<string, { historyCount: number; reply: string }>();
  const histories = new Map<string, number>();
  return (input, init) => {
    if (init?.body === "{") {
      return Promise.resolve(
        Response.json({ error: "malformed_json" }, { status: 400 })
      );
    }
    const payload = parsePayload(init?.body);
    if (payload.idempotencyKey === null) {
      return Promise.resolve(
        Response.json({ error: "invalid_input" }, { status: 400 })
      );
    }
    const objectName = new URL(String(input)).searchParams.get("object");
    const routedName = isolated ? objectName : "shared";
    const key =
      payload.idempotencyKey === undefined
        ? undefined
        : `${routedName}:${payload.idempotencyKey}`;
    const prior = key === undefined ? undefined : committed.get(key);
    if (prior !== undefined) {
      return Promise.resolve(
        Response.json({
          commitCount: 1,
          historyCount: prior.historyCount,
          ok: true,
          reply: prior.reply,
        })
      );
    }
    const historyCount = (histories.get(routedName ?? "") ?? 0) + 1;
    histories.set(routedName ?? "", historyCount);
    const reply = `echo:${payload.text}`;
    if (key !== undefined) {
      committed.set(key, { historyCount, reply });
    }
    return Promise.resolve(
      Response.json({
        commitCount: 1,
        historyCount,
        ok: true,
        reply,
      })
    );
  };
}

function parsePayload(value: BodyInit | null | undefined): {
  readonly idempotencyKey?: string | null;
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
    ...("idempotencyKey" in parsed
      ? {
          idempotencyKey:
            typeof parsed.idempotencyKey === "string"
              ? parsed.idempotencyKey
              : null,
        }
      : {}),
    text: parsed.text,
  };
}
