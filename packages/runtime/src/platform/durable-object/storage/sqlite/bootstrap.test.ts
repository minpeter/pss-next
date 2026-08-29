import { describe, expect, it } from "vitest";
import type { TurnRecord } from "../../../../execution";
import {
  createDurableObjectStorageHost,
  InMemoryDurableObjectStorage,
} from "../../host/storage-host";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import type { DurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";

const PREFIX = "pss-runtime";
const requiresSqlitePattern = /SQLite-backed/;

const createRun = (runId = "run-1"): TurnRecord => ({
  checkpointVersion: 0,
  kind: "user-turn",
  rootRunId: runId,
  runId,
  threadKey: "thread-1",
  status: "queued",
});

describe("createDurableObjectStorageHost store selection", () => {
  it("creates SQLite-backed in-memory storage by default", async () => {
    const storage = new InMemoryDurableObjectStorage();
    const host = createDurableObjectStorageHost({ storage });

    await host.store.turns.create(createRun());
    await host.store.events.append("run-1", { type: "turn-start" });

    const events: unknown[] = [];
    for await (const entry of host.store.events.read("run-1")) {
      events.push(entry.event);
    }
    expect(events).toEqual([{ type: "turn-start" }]);
  });

  it("uses SQLite row stores for events/checkpoints on a SQLite-backed Durable Object", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createDurableObjectStorageHost({ storage });

    await host.store.turns.create(createRun());

    const big = "x".repeat(120_000);
    // 20 events * ~120KB ~= ~2.4MB — past the Durable Object per-value limit
    // that append-only SQLite rows avoid.
    for (let index = 0; index < 20; index += 1) {
      await host.store.events.append("run-1", {
        output: big,
        toolCallId: "call_1",
        toolName: "web_search",
        type: "tool-result",
      });
    }
    // 20 checkpoints, each embedding a full thread snapshot — past 2MB too.
    for (let version = 1; version <= 20; version += 1) {
      await host.store.checkpoints.append(
        {
          checkpointId: `cp-${version}`,
          phase: "after-tool",
          runId: "run-1",
          runtimeState: {},
          threadSnapshot: { history: [big] },
          version,
        },
        { expectedVersion: version - 1 }
      );
    }

    const events: unknown[] = [];
    for await (const entry of host.store.events.read("run-1")) {
      events.push(entry.event);
    }
    expect(events).toHaveLength(20);

    await expect(host.store.checkpoints.latest("run-1")).resolves.toMatchObject(
      { checkpointId: "cp-20", version: 20 }
    );

    // The SQLite-backed stores do not write per-run list blobs.
    expect(
      await storage.get(storeKey(PREFIX, "events", "run-1"))
    ).toBeUndefined();
    expect(
      await storage.get(storeKey(PREFIX, "checkpoints", "run-1"))
    ).toBeUndefined();
  });

  it("rolls back SQLite rows with failed execution transactions", async () => {
    const storage = new InMemoryDurableObjectStorage();
    const host = createDurableObjectStorageHost({ storage });

    await expect(
      host.store.transaction(async (tx) => {
        await tx.turns.create(createRun("run-rollback"));
        await tx.events.append("run-rollback", { type: "turn-start" });
        await tx.checkpoints.append(
          {
            checkpointId: "checkpoint-rollback",
            phase: "before-model",
            runId: "run-rollback",
            runtimeState: {},
            threadSnapshot: { messages: [] },
            version: 1,
          },
          { expectedVersion: 0 }
        );
        await tx.notifications.enqueue({
          idempotencyKey: "notify-rollback",
          input: { text: "resume", type: "user-input" },
          notificationId: "notification-rollback",
          runId: "run-rollback",
          threadKey: "thread-rollback",
          status: "pending",
        });
        await tx.threads.commit(
          "thread-rollback",
          { state: { messages: ["inside transaction"] } },
          { expectedVersion: null }
        );
        throw new Error("transaction failed");
      })
    ).rejects.toThrow("transaction failed");

    await expect(host.store.turns.get("run-rollback")).resolves.toBeNull();
    await expect(
      host.store.threads.load("thread-rollback")
    ).resolves.toBeNull();
    await expect(
      host.store.notifications.getByIdempotencyKey("notify-rollback")
    ).resolves.toBeNull();
    await expect(
      host.store.checkpoints.latest("run-rollback")
    ).resolves.toBeNull();

    const events: unknown[] = [];
    for await (const entry of host.store.events.read("run-rollback")) {
      events.push(entry);
    }
    expect(events).toEqual([]);
  });

  it("rejects non-SQLite Durable Object storage", () => {
    expect(() =>
      createDurableObjectStorageHost({
        storage: {} as DurableObjectStorage,
      })
    ).toThrow(requiresSqlitePattern);
  });
});
