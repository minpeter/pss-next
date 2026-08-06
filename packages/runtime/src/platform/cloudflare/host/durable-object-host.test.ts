import { describe, expect, expectTypeOf, it } from "vitest";
import { describeAgentHostFaultContract } from "../../../contracts/agent-host-fault-contract";
import type { AgentEvent, AgentTurn } from "../../../index";
import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareThreadPrompt,
  type CloudflareDurableObjectId,
  type CloudflareDurableObjectNamespace,
  type CloudflareDurableObjectState,
  type CloudflareDurableObjectStorage,
  type CloudflareDurableObjectStub,
  createCloudflareStorageHost,
  drainAgentTurn,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
} from "../index";
import { InMemorySqlStorage } from "../sql/node-test/node-sqlite-storage";
import type { CloudflareDurableObjectTransactionStorage } from "../storage/durable-object/durable-object-storage";

let conformancePrefix = 0;
describeAgentHostFaultContract({
  createHost: () =>
    createCloudflareStorageHost({
      prefix: `host-conformance-${conformancePrefix++}`,
      storage: new InMemoryCloudflareDurableObjectStorage(),
    }),
  name: "Cloudflare Durable Object",
});

interface ScheduledWorkProbeRow {
  readonly kind: string;
  readonly payload: string;
  readonly run_id: string | null;
  readonly thread_key: string | null;
  readonly work_id: string;
}

describe("Cloudflare Durable Object host adapter", () => {
  it("stores scheduled runs and thread prompts until they are acked", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });
    const runId = "background:bg_cloudflare_delayed";
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
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      runId,
    ]);
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([prompt]);
    await ackScheduledCloudflareRun(storage, runId);
    await ackScheduledCloudflareThreadPrompt(storage, prompt);

    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([]);
    expect(readScheduledWorkRows(storage)).toEqual([]);
    await expect(
      host.store.notifications.claimByIdempotencyKey(idempotencyKey)
    ).resolves.toMatchObject({ ok: true });
  });

  it("lists SQLite scheduled work with a row limit", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });

    await host.scheduler.enqueueRun("run-a");
    await host.scheduler.enqueueRun("run-b");
    await host.scheduler.enqueueRun("run-c");

    await expect(
      listScheduledCloudflareRuns(storage, { limit: 2 })
    ).resolves.toEqual(["run-a", "run-b"]);
    expect(readScheduledWorkRows(storage)).toHaveLength(3);
  });

  it("supports deleting SQLite scheduled work by normalized indexes in local tests", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });

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
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareStorageHost({ storage });

    await host.scheduler.enqueueRun("default-sql-run");
    await host.scheduler.resumeThread("default-sql-thread", {
      runId: "default-sql-notification",
    });

    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      "default-sql-run",
    ]);
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([
      { runId: "default-sql-notification", threadKey: "default-sql-thread" },
    ]);
  });

  it("uses the SQLite scheduled queue when transaction storage omits sql", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const cloudflareLikeStorage = withoutTransactionSql(storage);
    const host = createCloudflareStorageHost({
      storage: cloudflareLikeStorage,
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
      listScheduledCloudflareRuns(cloudflareLikeStorage)
    ).resolves.toEqual([prompt.runId]);
    await expect(
      listScheduledCloudflareThreadPrompts(cloudflareLikeStorage)
    ).resolves.toEqual([prompt]);

    await ackScheduledCloudflareRun(cloudflareLikeStorage, prompt.runId);
    await ackScheduledCloudflareThreadPrompt(cloudflareLikeStorage, prompt);

    expect(readScheduledWorkRows(storage)).toEqual([]);
  });

  it("observes drained run events when an event callback is provided", async () => {
    const runEvents = [
      { text: "first", type: "assistant-output" },
      { text: "second", type: "assistant-output" },
    ] satisfies readonly AgentEvent[];
    const observedEvents: AgentEvent[] = [];

    const drainedEvents = await drainAgentTurn(runWithEvents(runEvents), {
      onEvent: (event) => {
        observedEvents.push(event);
      },
    });

    expect(drainedEvents).toEqual(runEvents);
    expect(observedEvents).toEqual(runEvents);
  });

  it("types Durable Object platform shapes without Cloudflare worker globals", () => {
    type ExtraStub = CloudflareDurableObjectStub & {
      readonly kind: "extra";
    };

    expectTypeOf<
      CloudflareDurableObjectState["storage"]
    >().toEqualTypeOf<CloudflareDurableObjectStorage>();
    expectTypeOf<
      Parameters<CloudflareDurableObjectState["waitUntil"]>[0]
    >().toEqualTypeOf<Promise<unknown>>();
    expectTypeOf<
      ReturnType<CloudflareDurableObjectNamespace<ExtraStub>["idFromName"]>
    >().toEqualTypeOf<CloudflareDurableObjectId>();
    expectTypeOf<
      ReturnType<CloudflareDurableObjectNamespace<ExtraStub>["get"]>
    >().toEqualTypeOf<ExtraStub>();
  });
});

function runWithEvents(events: readonly AgentEvent[]): AgentTurn {
  return {
    events: () => eventStream(events),
  };
}

async function* eventStream(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

function readScheduledWorkRows(
  storage: InMemoryCloudflareDurableObjectStorage
): ScheduledWorkProbeRow[] {
  return (storage.sql as InMemorySqlStorage)
    .exec<ScheduledWorkProbeRow>(
      "SELECT kind, work_id, payload, thread_key, run_id FROM pss_scheduled_work WHERE prefix = ? ORDER BY kind, created_at, work_id",
      "pss-runtime"
    )
    .toArray();
}

function withoutTransactionSql(
  storage: InMemoryCloudflareDurableObjectStorage
): CloudflareDurableObjectStorage {
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
        } satisfies CloudflareDurableObjectTransactionStorage)
      ),
  };
}
