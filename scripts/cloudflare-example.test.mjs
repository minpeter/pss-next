import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readText(path) {
  return readFileSync(path, "utf8");
}

describe("cloudflare durable object adapter", () => {
  it("exposes the packaged Worker/Durable Object adapter surface", () => {
    const hostSource = readText(
      "packages/runtime/src/platform/durable-object/host/storage-host.ts"
    );
    const storeSource = readText(
      "packages/runtime/src/platform/durable-object/storage/execution/store.ts"
    );
    const platformHostSource = readText(
      "packages/runtime/src/platform/durable-object/cloudflare/host/create-cloudflare-host.ts"
    );
    const platformContextSource = readText(
      "packages/runtime/src/platform/durable-object/cloudflare/agents/context.ts"
    );
    const threadStoreSource = readText(
      "packages/runtime/src/platform/durable-object/storage/sqlite/thread-store.ts"
    );
    const threadStoreSchemaSource = readText(
      "packages/runtime/src/platform/durable-object/storage/sqlite/thread-store-sql/schema/bootstrap.ts"
    );

    expect(hostSource).not.toContain("createFakeCloudflareDurableObjectHost");
    expect(hostSource).toContain("createDurableObjectStorageHost");
    expect(hostSource).toContain("createDurableObjectScheduledWorkScheduler");
    expect(hostSource).not.toContain("setAlarm");
    expect(platformHostSource).toContain("createCloudflareHost");
    expect(platformHostSource).toContain(
      "createCloudflareAgentsFiberScheduler"
    );
    expect(platformContextSource).toContain("createCloudflarePlatformContext");
    expect(storeSource).toContain("DurableObjectExecutionStore");
    expect(storeSource).toContain("DurableObjectSqliteThreadStore");
    expect(threadStoreSource).toContain("DurableObjectSqliteThreadStore");
    expect(threadStoreSchemaSource).toContain("pss_thread_meta");
  });

  it("drives durable object scheduled work through the queue-only storage host", async () => {
    const { InMemorySqlStorage } = await import(
      "../packages/runtime/src/platform/durable-object/sql/node-test/node-sqlite-storage.ts"
    );
    const {
      InMemoryDurableObjectStorage,
      ackScheduledDurableObjectRun,
      ackScheduledDurableObjectThreadPrompt,
      createDurableObjectStorageHost,
      listScheduledDurableObjectRuns,
      listScheduledDurableObjectThreadPrompts,
    } = await import(
      "../packages/runtime/src/platform/durable-object/host/storage-host.ts"
    );
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createDurableObjectStorageHost({ storage });
    const runId = "background:bg_cloudflare_delayed";
    const idempotencyKey = "background-complete:example:bg_delayed";
    const notificationRunId = "notification-run-delayed";

    await host.scheduler.enqueueRun(runId);
    await host.scheduler.resumeThread("example", {
      idempotencyKey,
      runId: notificationRunId,
    });
    await host.store.notifications.enqueue({
      idempotencyKey,
      input: { text: "ready", type: "user-input" },
      notificationId: "notification-delayed",
      runId: notificationRunId,
      status: "pending",
      threadKey: "example",
    });

    await expect(listScheduledDurableObjectRuns(storage)).resolves.toEqual([
      runId,
    ]);
    await expect(
      listScheduledDurableObjectThreadPrompts(storage)
    ).resolves.toEqual([
      {
        idempotencyKey,
        runId: notificationRunId,
        threadKey: "example",
      },
    ]);

    await ackScheduledDurableObjectRun(storage, runId);
    await ackScheduledDurableObjectThreadPrompt(storage, {
      idempotencyKey,
      runId: notificationRunId,
      threadKey: "example",
    });

    await expect(listScheduledDurableObjectRuns(storage)).resolves.toEqual([]);
    await expect(
      listScheduledDurableObjectThreadPrompts(storage)
    ).resolves.toEqual([]);
  });
});
