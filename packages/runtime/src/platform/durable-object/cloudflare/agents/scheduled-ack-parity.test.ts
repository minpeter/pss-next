import { describe, expect, it } from "vitest";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { DurableObjectTransactionStorage } from "../../storage/durable-object/durable-object-storage";
import {
  isSqlStorage,
  withSqlStorage,
} from "../../storage/durable-object/durable-object-storage";
import {
  captureRetryOwnership,
  createRetryHost,
  seedRetryableNotification,
} from "./fiber-retry-test-support";
import {
  ackScheduledCloudflareAgentsRun,
  ackScheduledCloudflareAgentsThreadPrompt,
  type CloudflareAgentsScheduledThreadPrompt,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  createCloudflareAgentsFiberRetryScheduler,
  listScheduledCloudflareAgentsRuns,
  listScheduledCloudflareAgentsThreadPrompts,
} from "./index";
import { createFakeCloudflareAgent } from "./test-support";

const prefix = "tenant-a";

describe("Cloudflare Agents scheduled ack parity", () => {
  it("acks listed run retry rows stored with attempt-aware work ids", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const runId = "background:bg_retry_ack";
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      retryRunAfterMs: 1000,
      storage,
    });

    const payload = cloudflareAgentsRunPayload({ prefix, runId });
    captureRetryOwnership(payload, null);

    await expect(retry(payload, "event-budget")).resolves.toBe(true);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix })
    ).resolves.toEqual([runId]);

    await ackScheduledCloudflareAgentsRun(storage, runId, { prefix });

    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix })
    ).resolves.toEqual([]);
  });

  it("acks listed thread retry rows stored with notification and attempt-aware work ids", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const prompt: CloudflareAgentsScheduledThreadPrompt = {
      idempotencyKey: "source:thread:1",
      notificationId: "notification:1",
      runId: "background:bg_thread_retry_ack",
      threadKey: "thread-a",
    };
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      retryRunAfterMs: 1000,
      storage,
    });

    const payload = cloudflareAgentsThreadPayload({
      ...prompt,
      prefix,
      runId: "background:bg_thread_retry_ack",
    });
    captureRetryOwnership(payload, null);

    await expect(retry(payload, "event-budget")).resolves.toBe(true);
    const listed = await listScheduledCloudflareAgentsThreadPrompts(storage, {
      prefix,
    });
    expect(listed).toEqual([prompt]);
    const [listedPrompt] = listed;
    if (listedPrompt === undefined) {
      throw new Error("Expected a listed Cloudflare Agents thread prompt.");
    }

    await ackScheduledCloudflareAgentsThreadPrompt(storage, listedPrompt, {
      prefix,
    });

    await expect(
      listScheduledCloudflareAgentsThreadPrompts(storage, { prefix })
    ).resolves.toEqual([]);
  });

  it("leaves no retry side effects when the owned transition conflicts", async () => {
    // Given: an eligible unleased notification whose status changes after the
    // transaction eligibility read but before its owned transition read.
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const transaction = storage.transaction?.bind(storage);
    if (!transaction) {
      throw new TypeError("Test storage requires transaction support.");
    }
    const host = createRetryHost(cloudflareAgent, () => Promise.resolve(null));
    const runId = "background:bg_transition_conflict";
    await seedRetryableNotification(host, runId);
    const initialRun = await host.store.turns.get(runId);
    if (!initialRun) {
      throw new TypeError("Test run disappeared before conflict injection.");
    }
    const { lease: _lease, ...runWithoutLease } = initialRun;
    const runningRun = { ...runWithoutLease, status: "running" as const };
    await host.store.turns.update(runningRun);
    const completedRun = { ...runningRun, status: "completed" as const };
    const conflictedStorage = new Proxy(storage, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "transaction") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async <T>(
          fn: (tx: DurableObjectTransactionStorage) => Promise<T>
        ): Promise<T> =>
          await transaction(async (tx) => {
            if (!isSqlStorage(tx.sql)) {
              throw new TypeError("Test transaction requires SQL storage.");
            }
            const sql = tx.sql;
            let runReads = 0;
            const conflictedSql: SqlStorage = {
              exec: (query, ...bindings) => {
                const readsRun = query.includes(
                  "SELECT record FROM pss_run WHERE prefix = ? AND run_id = ?"
                );
                if (readsRun) {
                  runReads += 1;
                }
                if (readsRun && runReads === 2) {
                  sql.exec(
                    "INSERT INTO pss_run (prefix, run_id, record, dedupe_key, parent_run_id, root_run_id, thread_key, status, checkpoint_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(prefix, run_id) DO UPDATE SET record = excluded.record",
                    prefix,
                    runId,
                    JSON.stringify(completedRun),
                    completedRun.dedupeKey ?? null,
                    completedRun.parentRunId ?? null,
                    completedRun.rootRunId,
                    completedRun.threadKey,
                    completedRun.status,
                    completedRun.checkpointVersion,
                    1,
                    1
                  );
                }
                return sql.exec(query, ...bindings);
              },
            };
            return await fn(withSqlStorage(tx, conflictedSql));
          });
      },
    });
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      storage: conflictedStorage,
    });

    const payload = cloudflareAgentsRunPayload({ prefix, runId });
    captureRetryOwnership(payload, null);

    // When: retry loses its owned transition after eligibility passed.
    const retried = await retry(payload, "event-budget");

    // Then: the winner remains terminal and no schedule or release escapes.
    expect(retried).toBe(false);
    expect(cloudflareAgent.scheduled).toEqual([]);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix })
    ).resolves.toEqual([]);
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      runId,
      status: "completed",
    });
    await expect(
      host.store.notifications.getByIdempotencyKey(`dedupe:${runId}`)
    ).resolves.toMatchObject({ runId, status: "acked" });
  });

  it("does not leave retry side effects when notification retry preparation is not claimable", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const host = createRetryHost(cloudflareAgent, () => Promise.resolve(null));
    const runId = "background:bg_missing_dedupe_not_claimable";

    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "notification",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "thread-a",
    });

    await expect(host.scheduler.enqueueRun(runId)).rejects.toThrow(
      "PSS Runtime fiber interrupted: not-claimable"
    );

    expect(cloudflareAgent.scheduled).toEqual([]);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix })
    ).resolves.toEqual([]);
  });
});
