import { describe, expect, it } from "vitest";
import { createDurableObjectStorageHost } from "../../host/storage-host";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import {
  collectStorageMetrics,
  summarizeStorageLatencyTimings,
} from "./storage-metrics";

describe("storage metrics", () => {
  it("collects row counts, chunk bytes, and scheduled backlog", async () => {
    const sql = new InMemorySqlStorage();
    const storage = new InMemoryDurableObjectStorage({ sql });
    const host = createDurableObjectStorageHost({
      maxPayloadBytes: 220,
      prefix: "metrics-test",
      storage,
    });
    const threadKey = "agent:user:thread";
    const runId = `${threadKey}:run-1`;

    await host.store.threads.commit(
      threadKey,
      {
        state: {
          history: [{ content: "한".repeat(480), role: "user" }],
          schemaVersion: 1,
        },
      },
      { expectedVersion: null }
    );
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey,
    });
    await host.store.events.append(runId, {
      text: "가".repeat(480),
      type: "assistant-output",
    });
    await host.store.checkpoints.append(
      {
        checkpointId: `${runId}:checkpoint-1`,
        phase: "after-model",
        runId,
        runtimeState: { output: "나".repeat(480) },
        threadSnapshot: { threadKey, version: "1" },
        version: 1,
      },
      { expectedVersion: 0 }
    );
    await host.store.notifications.enqueue({
      idempotencyKey: `${runId}:notification`,
      input: { text: "다".repeat(480), type: "user-input" },
      notificationId: `${runId}:notification`,
      runId,
      status: "pending",
      threadKey,
    });
    await host.store.inputs.admit({
      input: { text: "라".repeat(480), type: "user-input" },
      kind: "steer",
      messageId: `${runId}:input`,
      placement: "step-start",
      threadKey,
    });
    await host.scheduler.enqueueRun(runId);
    await host.scheduler.resumeThread(threadKey, {
      idempotencyKey: `${runId}:notification`,
      runId,
    });

    const metrics = collectStorageMetrics(sql);

    expect(metrics.rowCounts.pss_thread_meta).toBe(1);
    expect(metrics.rowCounts.pss_thread_message).toBe(1);
    expect(metrics.rowCounts.pss_run).toBe(1);
    expect(metrics.rowCounts.pss_event).toBe(1);
    expect(metrics.rowCounts.pss_checkpoint).toBe(1);
    expect(metrics.rowCounts.pss_notification).toBe(1);
    expect(metrics.rowCounts.pss_thread_input).toBe(1);
    expect(metrics.chunkBytes.threadMessage).toBeGreaterThan(0);
    expect(metrics.chunkBytes.payload).toBeGreaterThan(0);
    expect(metrics.chunkBytes.total).toBeGreaterThan(
      sqlChunkCharacterCount(sql)
    );
    expect(metrics.scheduledBacklog).toEqual({
      run: 1,
      threadPrompt: 1,
      total: 2,
    });
  });

  it("summarizes latency timings with p50, p95, and max", () => {
    const summary = summarizeStorageLatencyTimings([
      { label: "fast", ms: 1 },
      { label: "middle", ms: 10 },
      { label: "slow", ms: 20 },
    ]);

    expect(summary).toMatchObject({
      count: 3,
      maxMs: 20,
      p50Ms: 10,
      p95Ms: 20,
    });
    expect(summary.byLabel.map((timing) => timing.label)).toEqual([
      "fast",
      "middle",
      "slow",
    ]);
  });
});

function sqlChunkCharacterCount(sql: InMemorySqlStorage): number {
  const [payloadRow] = sql
    .exec<{ readonly count: number }>(
      "SELECT COALESCE(SUM(LENGTH(chunk)), 0) AS count FROM pss_payload_chunk"
    )
    .toArray();
  const [threadRow] = sql
    .exec<{ readonly count: number }>(
      "SELECT COALESCE(SUM(LENGTH(chunk)), 0) AS count FROM pss_thread_message_chunk"
    )
    .toArray();
  return (payloadRow?.count ?? 0) + (threadRow?.count ?? 0);
}
