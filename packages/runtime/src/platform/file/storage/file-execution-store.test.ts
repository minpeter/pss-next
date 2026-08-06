import { readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { describeExecutionStoreContract } from "../../../contracts/execution-store/contract";
import { FileExecutionStore } from "./file-execution-store";
import {
  base64Url,
  checkpointRecord,
  collectEvents,
  collectThreadEvents,
  contractTempDir,
  createDeferred,
  currentDataDirectory,
  notificationRecord,
  runRecord,
  tempDir,
} from "./file-execution-store-test-support";

describeExecutionStoreContract({
  createStore: () => new FileExecutionStore(contractTempDir()),
  name: "FileExecutionStore",
});

describe("FileExecutionStore", () => {
  it("persists execution ports in separate files across store instances", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    const run = runRecord("run:persist", {
      dedupeKey: "dedupe:persist",
      parentRunId: "parent:persist",
    });
    const checkpoint = checkpointRecord("run:persist", 1);
    const notification = notificationRecord("notify:persist", {
      runId: "run:persist",
    });

    await expect(store.turns.create(run)).resolves.toEqual({
      ok: true,
      record: run,
    });
    await expect(
      store.events.append("run:persist", { type: "turn-start" })
    ).resolves.toEqual({ offset: 1 });
    await expect(
      store.checkpoints.append(checkpoint, { expectedVersion: 0 })
    ).resolves.toEqual({
      ok: true,
      version: 1,
    });
    await expect(store.notifications.enqueue(notification)).resolves.toEqual({
      ok: true,
    });
    await expect(
      store.threads.commit(
        "thread:persist",
        { state: { messages: ["persisted"] } },
        { expectedVersion: null }
      )
    ).resolves.toEqual({ ok: true, version: "1" });

    const reopened = new FileExecutionStore(directory);
    await expect(reopened.turns.get("run:persist")).resolves.toEqual({
      ...run,
      checkpointVersion: 1,
    });
    await expect(
      reopened.turns.getByDedupeKey("dedupe:persist")
    ).resolves.toEqual({
      ...run,
      checkpointVersion: 1,
    });
    await expect(
      reopened.turns.listByParentRunId("parent:persist")
    ).resolves.toEqual([{ ...run, checkpointVersion: 1 }]);
    await expect(reopened.checkpoints.latest("run:persist")).resolves.toEqual(
      checkpoint
    );
    await expect(
      collectEvents(reopened.events.read("run:persist"))
    ).resolves.toEqual([
      {
        cursor: { offset: 1 },
        event: { type: "turn-start" },
        runId: "run:persist",
      },
    ]);
    await expect(
      reopened.notifications.getByIdempotencyKey("notify:persist")
    ).resolves.toEqual(notification);
    await expect(reopened.threads.load("thread:persist")).resolves.toEqual({
      state: { messages: ["persisted"] },
      version: "1",
    });
    const dataDirectory = await currentDataDirectory(directory);

    await expect(readdir(join(dataDirectory, "threads"))).resolves.toContain(
      `${base64Url("thread:persist")}.json`
    );
    await expect(readdir(join(dataDirectory, "runs"))).resolves.toContain(
      `${base64Url("run:persist")}.json`
    );
    await expect(readdir(join(dataDirectory, "events"))).resolves.toContain(
      `${base64Url("run:persist")}.jsonl`
    );
    await expect(
      readdir(join(dataDirectory, "checkpoints", base64Url("run:persist")))
    ).resolves.toEqual(["1.json"]);
    await expect(
      readdir(join(dataDirectory, "notifications"))
    ).resolves.toContain(`${base64Url("notify:persist")}.json`);
  });

  it("reports invalid stored event offsets with file context", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.events.append("run:corrupt", { type: "turn-start" });
    const dataDirectory = await currentDataDirectory(directory);
    const file = join(
      dataDirectory,
      "events",
      `${base64Url("run:corrupt")}.jsonl`
    );
    await writeFile(
      file,
      `${JSON.stringify({
        cursor: { offset: Number.MAX_SAFE_INTEGER + 1 },
        event: { type: "turn-start" },
        runId: "run:corrupt",
      })}\n`,
      "utf8"
    );

    await expect(
      collectEvents(store.events.read("run:corrupt"))
    ).rejects.toThrow(
      `Invalid FileExecutionStore event log ${JSON.stringify(file)}`
    );
  });

  it("rolls back file-backed transaction writes after a failure", async () => {
    const store = new FileExecutionStore(await tempDir());

    await expect(
      store.transaction(async (tx) => {
        await tx.turns.create(runRecord("run:rollback"));
        await tx.events.append("run:rollback", { type: "turn-start" });
        await tx.checkpoints.append(checkpointRecord("run:rollback", 1), {
          expectedVersion: 0,
        });
        await tx.notifications.enqueue(
          notificationRecord("notify:rollback", { runId: "run:rollback" })
        );
        await tx.threads.commit(
          "thread:rollback",
          { state: { value: "rollback" } },
          { expectedVersion: null }
        );
        throw new Error("rollback me");
      })
    ).rejects.toThrow("rollback me");

    await expect(store.turns.get("run:rollback")).resolves.toBeNull();
    await expect(
      collectEvents(store.events.read("run:rollback"))
    ).resolves.toEqual([]);
    await expect(store.checkpoints.latest("run:rollback")).resolves.toBeNull();
    await expect(
      store.notifications.getByIdempotencyKey("notify:rollback")
    ).resolves.toBeNull();
    await expect(store.threads.load("thread:rollback")).resolves.toBeNull();
  });

  it("preserves thread events across committed transactions", async () => {
    const store = new FileExecutionStore(await tempDir());

    await expect(
      store.threadEvents.append("thread:replay", { type: "turn-start" })
    ).resolves.toEqual({ offset: 1 });

    await store.transaction(async (tx) => {
      await tx.threads.commit(
        "thread:replay",
        { state: { value: "committed transaction" } },
        { expectedVersion: null }
      );
    });

    await expect(
      collectThreadEvents(store.threadEvents.read("thread:replay"))
    ).resolves.toEqual([
      {
        cursor: { offset: 1 },
        event: { type: "turn-start" },
        threadKey: "thread:replay",
      },
    ]);
  });

  it("serializes direct thread writes against transaction directory swaps", async () => {
    const store = new FileExecutionStore(await tempDir());
    const transactionStarted = createDeferred();
    const transactionCanFinish = createDeferred();
    let outsideSettled = false;

    const transaction = store.transaction(async (tx) => {
      await tx.threads.commit(
        "thread:inside",
        { state: { value: "inside" } },
        { expectedVersion: null }
      );
      transactionStarted.resolve();
      await transactionCanFinish.promise;
    });

    await transactionStarted.promise;

    const outside = store.threads
      .commit(
        "thread:outside",
        { state: { value: "outside" } },
        { expectedVersion: null }
      )
      .then(() => {
        outsideSettled = true;
      });

    await Promise.resolve();
    expect(outsideSettled).toBe(false);

    transactionCanFinish.resolve();
    await transaction;
    await outside;

    await expect(store.threads.load("thread:inside")).resolves.toMatchObject({
      state: { value: "inside" },
    });
    await expect(store.threads.load("thread:outside")).resolves.toMatchObject({
      state: { value: "outside" },
    });
  });

  it("does not reclaim a live transaction lock regardless of its mtime", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    const transactionStarted = createDeferred();
    const transactionCanFinish = createDeferred();
    let outsideSettled = false;

    const transaction = store.transaction(async (tx) => {
      await tx.threads.commit(
        "thread:inside",
        { state: { value: "inside" } },
        { expectedVersion: null }
      );
      transactionStarted.resolve();
      await transactionCanFinish.promise;
    });

    await transactionStarted.promise;
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(join(directory, ".execution.lock"), staleTime, staleTime);
    await setTimeout(150);

    const outside = store.threads
      .commit(
        "thread:outside",
        { state: { value: "outside" } },
        { expectedVersion: null }
      )
      .then(() => {
        outsideSettled = true;
      });

    await setTimeout(20);
    expect(outsideSettled).toBe(false);

    transactionCanFinish.resolve();
    await transaction;
    await outside;

    await expect(store.threads.load("thread:inside")).resolves.toMatchObject({
      state: { value: "inside" },
    });
    await expect(store.threads.load("thread:outside")).resolves.toMatchObject({
      state: { value: "outside" },
    });
  });
});
