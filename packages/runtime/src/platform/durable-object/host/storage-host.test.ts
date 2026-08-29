import { describe, expect, it } from "vitest";
import { describeAgentHostFaultContract } from "../../../contracts/agent-host-fault-contract";
import { InMemorySqlStorage } from "../sql/node-test/node-sqlite-storage";
import type { DurableObjectTransactionStorage } from "../storage/durable-object/durable-object-storage";
import {
  ackScheduledDurableObjectRun,
  ackScheduledDurableObjectThreadPrompt,
  createDurableObjectStorageHost,
  type DurableObjectStorage,
  InMemoryDurableObjectStorage,
  listScheduledDurableObjectRuns,
  listScheduledDurableObjectThreadPrompts,
} from "./storage-host";

let conformancePrefix = 0;
describeAgentHostFaultContract({
  createHost: () => ({
    host: createDurableObjectStorageHost({
      prefix: `host-conformance-${conformancePrefix++}`,
      storage: new InMemoryDurableObjectStorage(),
    }),
  }),
  name: "Durable Object",
});

interface ScheduledWorkProbeRow {
  readonly kind: string;
  readonly payload: string;
  readonly run_id: string | null;
  readonly thread_key: string | null;
  readonly work_id: string;
}

describe("Durable Object storage host", () => {
  it("stores scheduled runs and thread prompts until they are acked", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createDurableObjectStorageHost({ storage });
    const runId = "background:bg_durable_object_delayed";
    const idempotencyKey = "background-complete:example:bg_delayed";
    const notificationRunId = "notification-run-delayed";
    const prompt = {
      idempotencyKey,
      runId: notificationRunId,
      threadKey: "example",
    };

    await host.scheduler.enqueueRun(runId);
    await host.scheduler.enqueueRun(runId);
    await host.scheduler.resumeThread("example", {
      idempotencyKey,
      runId: notificationRunId,
    });
    await host.scheduler.resumeThread("example", {
      idempotencyKey,
      runId: notificationRunId,
    });
    await host.store.notifications.enqueue({
      idempotencyKey,
      input: { text: "ready", type: "user-input" },
      notificationId: "notification-delayed",
      runId: notificationRunId,
      threadKey: "example",
      status: "pending",
    });

    expect(readScheduledWorkRows(storage)).toHaveLength(2);
    expect(readScheduledWorkRows(storage)).toEqual([
      {
        kind: "run",
        payload: JSON.stringify(runId),
        run_id: runId,
        thread_key: null,
        work_id: runId,
      },
      {
        kind: "thread-prompt",
        payload: JSON.stringify(prompt),
        run_id: notificationRunId,
        thread_key: "example",
        work_id: expect.any(String),
      },
    ]);
    expect(readScheduledWorkRows(storage)[1]?.work_id).not.toContain("\u0000");
    await expect(listScheduledDurableObjectRuns(storage)).resolves.toEqual([
      runId,
    ]);
    await expect(
      listScheduledDurableObjectThreadPrompts(storage)
    ).resolves.toEqual([prompt]);
    await ackScheduledDurableObjectRun(storage, runId);
    await ackScheduledDurableObjectThreadPrompt(storage, prompt);

    await expect(listScheduledDurableObjectRuns(storage)).resolves.toEqual([]);
    await expect(
      listScheduledDurableObjectThreadPrompts(storage)
    ).resolves.toEqual([]);
    expect(readScheduledWorkRows(storage)).toEqual([]);
    await expect(
      host.store.notifications.claimByIdempotencyKey(idempotencyKey)
    ).resolves.toMatchObject({ ok: true });
  });

  it("lists SQLite scheduled work with a row limit", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createDurableObjectStorageHost({ storage });

    await host.scheduler.enqueueRun("run-a");
    await host.scheduler.enqueueRun("run-b");
    await host.scheduler.enqueueRun("run-c");

    await expect(
      listScheduledDurableObjectRuns(storage, { limit: 2 })
    ).resolves.toEqual(["run-a", "run-b"]);
    expect(readScheduledWorkRows(storage)).toHaveLength(3);
  });

  it("supports deleting SQLite scheduled work by normalized indexes in local tests", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createDurableObjectStorageHost({ storage });

    await host.scheduler.enqueueRun("run-a");
    await host.scheduler.resumeThread("thread-a", { runId: "run-a" });
    await host.scheduler.resumeThread("thread-b", { runId: "run-b" });

    storage.sql.exec(
      "DELETE FROM pss_scheduled_work WHERE prefix = ? AND thread_key = ?",
      "pss-runtime",
      "thread-a"
    );
    storage.sql.exec(
      "DELETE FROM pss_scheduled_work WHERE prefix = ? AND run_id = ?",
      "pss-runtime",
      "run-a"
    );

    expect(readScheduledWorkRows(storage)).toEqual([
      {
        kind: "thread-prompt",
        payload: JSON.stringify({ runId: "run-b", threadKey: "thread-b" }),
        run_id: "run-b",
        thread_key: "thread-b",
        work_id: expect.any(String),
      },
    ]);

    storage.sql.exec(
      "DELETE FROM pss_scheduled_work WHERE prefix = ? AND payload LIKE ? ESCAPE '\\'",
      "pss-runtime",
      '%"threadKey":"thread-b"%'
    );

    expect(readScheduledWorkRows(storage)).toEqual([]);
  });

  it("uses the SQLite scheduled queue with default in-memory Durable Object storage", async () => {
    const storage = new InMemoryDurableObjectStorage();
    const host = createDurableObjectStorageHost({ storage });

    await host.scheduler.enqueueRun("default-sql-run");
    await host.scheduler.resumeThread("default-sql-thread", {
      runId: "default-sql-notification",
    });

    await expect(listScheduledDurableObjectRuns(storage)).resolves.toEqual([
      "default-sql-run",
    ]);
    await expect(
      listScheduledDurableObjectThreadPrompts(storage)
    ).resolves.toEqual([
      { runId: "default-sql-notification", threadKey: "default-sql-thread" },
    ]);
  });

  it("uses the SQLite scheduled queue when transaction storage omits sql", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const durableObjectLikeStorage = withoutTransactionSql(storage);
    const host = createDurableObjectStorageHost({
      storage: durableObjectLikeStorage,
    });
    const prompt = {
      idempotencyKey: "tx-no-sql",
      runId: "tx-no-sql-run",
      threadKey: "tx-no-sql-thread",
    };

    await host.scheduler.enqueueRun(prompt.runId);
    await host.scheduler.enqueueRun(prompt.runId);
    await host.scheduler.resumeThread(prompt.threadKey, {
      idempotencyKey: prompt.idempotencyKey,
      runId: prompt.runId,
    });
    await host.scheduler.resumeThread(prompt.threadKey, {
      idempotencyKey: prompt.idempotencyKey,
      runId: prompt.runId,
    });

    expect(readScheduledWorkRows(storage)).toHaveLength(2);
    await expect(
      listScheduledDurableObjectRuns(durableObjectLikeStorage)
    ).resolves.toEqual([prompt.runId]);
    await expect(
      listScheduledDurableObjectThreadPrompts(durableObjectLikeStorage)
    ).resolves.toEqual([prompt]);

    await ackScheduledDurableObjectRun(durableObjectLikeStorage, prompt.runId);
    await ackScheduledDurableObjectThreadPrompt(
      durableObjectLikeStorage,
      prompt
    );

    expect(readScheduledWorkRows(storage)).toEqual([]);
  });
});

function readScheduledWorkRows(
  storage: InMemoryDurableObjectStorage
): ScheduledWorkProbeRow[] {
  return (storage.sql as InMemorySqlStorage)
    .exec<ScheduledWorkProbeRow>(
      "SELECT kind, work_id, payload, thread_key, run_id FROM pss_scheduled_work WHERE prefix = ? ORDER BY kind, created_at, work_id",
      "pss-runtime"
    )
    .toArray();
}

function withoutTransactionSql(
  storage: InMemoryDurableObjectStorage
): DurableObjectStorage {
  return {
    delete: storage.delete.bind(storage),
    get: storage.get.bind(storage),
    put: storage.put.bind(storage),
    setAlarm: storage.setAlarm.bind(storage),
    sql: storage.sql,
    transaction: async (fn) =>
      await storage.transaction((tx) =>
        fn({
          delete: tx.delete.bind(tx),
          get: tx.get.bind(tx),
          put: tx.put.bind(tx),
          setAlarm: tx.setAlarm?.bind(tx),
        } satisfies DurableObjectTransactionStorage)
      ),
  };
}
