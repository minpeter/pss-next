import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileExecutionStore } from "./file-execution-store";
import {
  base64Url,
  collectEvents,
  currentDataDirectory,
  malformedCheckpointPattern,
  malformedEventPattern,
  malformedNotificationPattern,
  malformedRunPattern,
  malformedThreadPattern,
  notificationRecord,
  runRecord,
  tempDir,
} from "./file-execution-store-test-support";

describe("FileExecutionStore edge cases", () => {
  it("returns the existing run for duplicate run ids and dedupe keys", async () => {
    const store = new FileExecutionStore(await tempDir());
    const original = runRecord("run:duplicate", {
      dedupeKey: "dedupe:duplicate",
    });

    await expect(store.turns.create(original)).resolves.toEqual({
      ok: true,
      record: original,
    });
    await expect(
      store.turns.create({
        ...runRecord("run:duplicate"),
        checkpointVersion: 7,
        dedupeKey: "other-dedupe",
        status: "completed",
      })
    ).resolves.toEqual({
      ok: false,
      reason: "duplicate",
      record: original,
    });
    await expect(
      store.turns.create({
        ...runRecord("run:other"),
        dedupeKey: "dedupe:duplicate",
      })
    ).resolves.toEqual({
      ok: false,
      reason: "duplicate",
      record: original,
    });
    await expect(store.turns.get("run:duplicate")).resolves.toEqual(original);
    await expect(store.turns.get("run:other")).resolves.toBeNull();
  });

  it("claims only claimable runs after active leases expire", async () => {
    const store = new FileExecutionStore(await tempDir());
    await store.turns.create(runRecord("run:claim"));

    await expect(
      store.turns.claim("run:claim", {
        attempt: 1,
        leaseId: "lease-1",
        leaseMs: 100,
        nowMs: 1000,
      })
    ).resolves.toMatchObject({
      lease: { attempt: 1, leaseId: "lease-1", leaseUntilMs: 1100 },
      ok: true,
      record: { status: "leased" },
    });
    await expect(
      store.turns.claim("run:claim", {
        attempt: 2,
        leaseId: "lease-2",
        leaseMs: 100,
        nowMs: 1099,
      })
    ).resolves.toEqual({ ok: false, reason: "leased" });
    await expect(
      store.turns.claim("run:claim", {
        attempt: 2,
        leaseId: "lease-2",
        leaseMs: 50,
        nowMs: 1100,
      })
    ).resolves.toMatchObject({
      lease: { attempt: 2, leaseId: "lease-2", leaseUntilMs: 1150 },
      ok: true,
    });

    await store.turns.create(runRecord("run:done", { status: "completed" }));
    await expect(
      store.turns.claim("run:done", {
        attempt: 1,
        leaseId: "lease-done",
        leaseMs: 100,
        nowMs: 0,
      })
    ).resolves.toEqual({ ok: false, reason: "not-claimable" });
  });

  it("acks and releases notifications by idempotency key", async () => {
    const store = new FileExecutionStore(await tempDir());
    const notification = notificationRecord("notify:claim");

    await expect(store.notifications.enqueue(notification)).resolves.toEqual({
      ok: true,
    });
    await expect(
      store.notifications.claimByIdempotencyKey("notify:claim")
    ).resolves.toEqual({
      ok: true,
      record: { ...notification, status: "acked" },
    });
    await expect(
      store.notifications.getByIdempotencyKey("notify:claim")
    ).resolves.toEqual({ ...notification, status: "acked" });
    await expect(
      store.notifications.claimByIdempotencyKey("notify:claim")
    ).resolves.toEqual({
      ok: false,
      reason: "already-claimed",
      record: { ...notification, status: "acked" },
    });

    await store.notifications.releaseByIdempotencyKey("notify:claim");

    await expect(
      store.notifications.getByIdempotencyKey("notify:claim")
    ).resolves.toEqual(notification);
  });

  it("throws deterministic errors for malformed persisted JSON files", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await expect(store.turns.get("run:missing")).resolves.toBeNull();
    await store.turns.create(
      runRecord("checkpoint:bad", { checkpointVersion: 1 })
    );
    const dataDirectory = await currentDataDirectory(directory);

    await mkdir(join(dataDirectory, "runs"), { recursive: true });
    await mkdir(join(dataDirectory, "events"), { recursive: true });
    await mkdir(
      join(dataDirectory, "checkpoints", base64Url("checkpoint:bad")),
      {
        recursive: true,
      }
    );
    await mkdir(join(dataDirectory, "notifications"), { recursive: true });
    await mkdir(join(dataDirectory, "threads"), { recursive: true });
    await writeFile(
      join(dataDirectory, "runs", `${base64Url("run:bad")}.json`),
      "{ nope",
      "utf8"
    );
    await writeFile(
      join(dataDirectory, "events", `${base64Url("run:bad")}.jsonl`),
      "{ nope\n",
      "utf8"
    );
    await writeFile(
      join(dataDirectory, "checkpoints", base64Url("checkpoint:bad"), "1.json"),
      "{ nope",
      "utf8"
    );
    await writeFile(
      join(dataDirectory, "notifications", `${base64Url("notify:bad")}.json`),
      "{ nope",
      "utf8"
    );
    await writeFile(
      join(dataDirectory, "threads", `${base64Url("thread:bad")}.json`),
      "{ nope",
      "utf8"
    );

    await expect(store.turns.get("run:bad")).rejects.toThrow(
      malformedRunPattern
    );
    await expect(collectEvents(store.events.read("run:bad"))).rejects.toThrow(
      malformedEventPattern
    );
    await expect(store.checkpoints.latest("checkpoint:bad")).rejects.toThrow(
      malformedCheckpointPattern
    );
    await expect(
      store.notifications.getByIdempotencyKey("notify:bad")
    ).rejects.toThrow(malformedNotificationPattern);
    await expect(store.threads.load("thread:bad")).rejects.toThrow(
      malformedThreadPattern
    );
  });
});
