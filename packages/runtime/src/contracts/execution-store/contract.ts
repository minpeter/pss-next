import { describe, expect, it } from "vitest";
import type { HostStore } from "../../execution";
import {
  appendCheckpoint,
  collectEvents,
  collectThreadEvents,
  createDeferred,
  createQueuedRun,
} from "./fixtures";
import { describeThreadEventLogContract } from "./thread-event-contract";
import { describeThreadInputInboxContract } from "./thread-input-contract";

export interface ExecutionStoreContractOptions {
  readonly createStore: () => HostStore;
  readonly name: string;
}

export function describeExecutionStoreContract({
  createStore,
  name,
}: ExecutionStoreContractOptions): void {
  describe(`${name} HostStore contract`, () => {
    it("transactions commit run checkpoint event and notification atomically", async () => {
      const store = createStore();

      await store.transaction(async (tx) => {
        await tx.turns.create(createQueuedRun());
        const checkpointResult = await tx.checkpoints.append(
          {
            checkpointId: "checkpoint-1",
            phase: "before-model",
            runId: "run-1",
            runtimeState: { step: 1 },
            threadSnapshot: { messages: [] },
            version: 1,
          },
          { expectedVersion: 0 }
        );
        await tx.events.append("run-1", { type: "turn-start" });
        await tx.notifications.enqueue({
          idempotencyKey: "notify-1",
          input: { text: "ready", type: "user-input" },
          notificationId: "notification-1",
          runId: "run-1",
          threadKey: "thread-1",
          status: "pending",
        });
        await tx.threads.commit(
          "thread-1",
          { state: { messages: ["committed transaction"] } },
          { expectedVersion: null }
        );

        expect(checkpointResult).toEqual({ ok: true, version: 1 });
      });

      await expect(store.turns.get("run-1")).resolves.toMatchObject({
        runId: "run-1",
        status: "queued",
      });
      await expect(store.checkpoints.latest("run-1")).resolves.toMatchObject({
        checkpointId: "checkpoint-1",
        version: 1,
      });
      expect(await collectEvents(store.events.read("run-1"))).toHaveLength(1);
      await expect(
        store.notifications.getByIdempotencyKey("notify-1")
      ).resolves.toMatchObject({
        notificationId: "notification-1",
      });
      await expect(store.threads.load("thread-1")).resolves.toMatchObject({
        state: { messages: ["committed transaction"] },
        version: "1",
      });
    });

    it("rolls back transaction writes when the transaction fails", async () => {
      const store = createStore();

      await expect(
        store.transaction(async (tx) => {
          await tx.turns.create(createQueuedRun());
          throw new Error("transaction failed");
        })
      ).rejects.toThrow("transaction failed");

      await expect(store.turns.get("run-1")).resolves.toBeNull();
    });

    it("rolls back transaction thread writes when the transaction fails", async () => {
      const store = createStore();

      await expect(
        store.transaction(async (tx) => {
          await tx.threads.commit(
            "thread-1",
            { state: { messages: ["inside transaction"] } },
            { expectedVersion: null }
          );
          throw new Error("transaction failed");
        })
      ).rejects.toThrow("transaction failed");

      await expect(store.threads.load("thread-1")).resolves.toBeNull();
    });

    it("deletes aggregate thread execution data when supported", async () => {
      const store = createStore();
      if (!store.deleteThread) {
        return;
      }
      await store.threads.commit(
        "thread-1",
        { state: { messages: ["delete me"] } },
        { expectedVersion: null }
      );
      await store.turns.create(createQueuedRun());
      await store.events.append("run-1", { type: "turn-start" });
      await appendCheckpoint(store, 0);
      await store.notifications.enqueue({
        idempotencyKey: "delete-notification",
        input: { text: "delete", type: "user-input" },
        notificationId: "delete-notification",
        runId: "run-1",
        threadKey: "thread-1",
        status: "pending",
      });
      await store.threadEvents?.append("thread-1", { type: "turn-start" });
      await store.inputs.admit({
        input: { text: "delete", type: "user-input" },
        kind: "send",
        messageId: "delete-input",
        threadKey: "thread-1",
      });

      await store.threads.commit(
        "thread-2",
        { state: { messages: ["keep me"] } },
        { expectedVersion: null }
      );
      await store.turns.create({
        ...createQueuedRun("run-2"),
        threadKey: "thread-2",
      });
      await store.events.append("run-2", { type: "turn-start" });
      await store.checkpoints.append(
        {
          checkpointId: "checkpoint-keep",
          phase: "before-model",
          runId: "run-2",
          runtimeState: {},
          threadSnapshot: {},
          version: 1,
        },
        { expectedVersion: 0 }
      );
      await store.notifications.enqueue({
        idempotencyKey: "keep-notification",
        input: { text: "keep", type: "user-input" },
        notificationId: "keep-notification",
        runId: "run-2",
        threadKey: "thread-2",
        status: "pending",
      });
      await store.threadEvents?.append("thread-2", { type: "turn-start" });
      await store.inputs.admit({
        input: { text: "keep", type: "user-input" },
        kind: "send",
        messageId: "keep-input",
        threadKey: "thread-2",
      });

      await store.deleteThread("thread-1");
      await store.deleteThread("thread-1");

      await expect(store.threads.load("thread-1")).resolves.toBeNull();
      await expect(store.turns.get("run-1")).resolves.toBeNull();
      await expect(store.checkpoints.latest("run-1")).resolves.toBeNull();
      expect(await collectEvents(store.events.read("run-1"))).toEqual([]);
      await expect(
        store.notifications.getByIdempotencyKey("delete-notification")
      ).resolves.toBeNull();
      await expect(store.threads.load("thread-2")).resolves.toMatchObject({
        state: { messages: ["keep me"] },
      });
      await expect(store.turns.get("run-2")).resolves.toMatchObject({
        threadKey: "thread-2",
      });
      await expect(store.checkpoints.latest("run-2")).resolves.toMatchObject({
        checkpointId: "checkpoint-keep",
      });
      expect(await collectEvents(store.events.read("run-2"))).toHaveLength(1);
      await expect(
        store.notifications.getByIdempotencyKey("keep-notification")
      ).resolves.toMatchObject({ threadKey: "thread-2" });
      await expect(
        store.inputs.claimNext("thread-2", "turn-idle")
      ).resolves.toMatchObject({ messageId: "keep-input" });
      if (store.threadEvents) {
        expect(
          await collectThreadEvents(store.threadEvents.read("thread-2"))
        ).toHaveLength(1);
      }
    });

    describeThreadInputInboxContract({ createStore });

    it("serializes concurrent transactions", async () => {
      const store = createStore();
      const firstStarted = createDeferred();
      const firstCanFinish = createDeferred();
      let secondSettled = false;

      const first = store.transaction(async (tx) => {
        await tx.turns.create(createQueuedRun("run-serial"));
        firstStarted.resolve();
        await firstCanFinish.promise;
      });
      await firstStarted.promise;
      const second = store
        .transaction(async (tx) => {
          const run = await tx.turns.get("run-serial");
          if (!run) {
            throw new Error("Expected first transaction to commit first.");
          }
          await tx.turns.update({ ...run, status: "cancelled" });
        })
        .then(() => {
          secondSettled = true;
        });

      await Promise.resolve();
      expect(secondSettled).toBe(false);
      firstCanFinish.resolve();
      await Promise.all([first, second]);

      await expect(store.turns.get("run-serial")).resolves.toMatchObject({
        status: "cancelled",
      });
    });

    it("rejects duplicate active run claims", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun());

      await expect(
        store.turns.claim("run-1", {
          attempt: 1,
          leaseId: "lease-1",
          leaseMs: 100,
          nowMs: 0,
        })
      ).resolves.toMatchObject({ ok: true });
      await expect(
        store.turns.claim("run-1", {
          attempt: 2,
          leaseId: "lease-2",
          leaseMs: 100,
          nowMs: 50,
        })
      ).resolves.toEqual({ ok: false, reason: "leased" });
    });

    it("keeps the existing run unchanged when create sees a duplicate run id", async () => {
      const store = createStore();
      const original = createQueuedRun("run-duplicate");

      const created = await store.turns.create(original);
      const duplicate = await store.turns.create({
        ...original,
        checkpointVersion: 7,
        status: "completed",
      });

      expect(created).toEqual({ ok: true, record: original });
      expect(duplicate).toEqual({
        ok: false,
        reason: "duplicate",
        record: original,
      });
      await expect(store.turns.get("run-duplicate")).resolves.toEqual(original);
    });

    it("rejects stale checkpoint writes", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun());

      const first = await appendCheckpoint(store, 0);
      const stale = await appendCheckpoint(store, 0);

      expect(first).toEqual({ ok: true, version: 1 });
      expect(stale).toEqual({
        currentVersion: 1,
        ok: false,
        reason: "stale-version",
      });
    });

    it("replays events from a cursor without duplicates", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun());

      const firstCursor = await store.events.append("run-1", {
        type: "turn-start",
      });
      await store.events.append("run-1", { type: "turn-end" });

      const replayed = await collectEvents(
        store.events.read("run-1", firstCursor)
      );

      expect(replayed).toEqual([
        {
          cursor: { offset: 2 },
          event: { type: "turn-end" },
          runId: "run-1",
        },
      ]);
    });

    describeThreadEventLogContract({ createStore });

    it("dedupes notifications by idempotency key", async () => {
      const store = createStore();
      const input = { text: "ready", type: "user-input" } as const;

      await expect(
        store.notifications.enqueue({
          idempotencyKey: "notify-1",
          input,
          notificationId: "notification-1",
          runId: "run-1",
          threadKey: "thread-1",
          status: "pending",
        })
      ).resolves.toEqual({ ok: true });
      await expect(
        store.notifications.enqueue({
          idempotencyKey: "notify-1",
          input,
          notificationId: "notification-2",
          runId: "run-1",
          threadKey: "thread-1",
          status: "pending",
        })
      ).resolves.toEqual({
        existingNotificationId: "notification-1",
        ok: false,
        reason: "duplicate",
      });
    });
  });
}
