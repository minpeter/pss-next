import { describe, expect, it } from "vitest";
import { createDurableObjectStorageHost } from "../../host/storage-host";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import type { StorageLatencyTiming } from "./storage-metrics";
import { summarizeStorageLatencyTimings } from "./storage-metrics";
import {
  collectEventSummaries,
  makeText,
  payloadBudget,
  runRecord,
  timed,
} from "./store-oversized-payload.test-support";

describe("DurableObjectExecutionStore oversized payload latency", () => {
  it("keeps storage overhead below 100ms for extreme local payload operations", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createDurableObjectStorageHost({
      maxPayloadBytes: payloadBudget,
      prefix: "oversized-payload-latency",
      storage,
    });
    const latencyThreadKey = "agent-latency:user-1:thread-1";
    const latencyRunId = "agent-latency:user-1:thread-1:run-1";
    const hugeUserInput = makeText("huge-user-input", 384_000);
    const hugeAssistantOutput = makeText("huge-assistant-output", 384_000);
    const timings: StorageLatencyTiming[] = [];

    const threadCommit = await timed(timings, "thread commit", () =>
      host.store.threads.commit(
        latencyThreadKey,
        {
          state: {
            history: [
              { content: hugeUserInput, role: "user" },
              { content: hugeAssistantOutput, role: "assistant" },
            ],
            schemaVersion: 1,
          },
        },
        { expectedVersion: null }
      )
    );
    expect(threadCommit).toEqual({ ok: true, version: "1" });

    const run = runRecord({
      runId: latencyRunId,
      threadKey: latencyThreadKey,
    });
    await timed(timings, "run create", () => host.store.turns.create(run));
    await timed(timings, "assistant event append", () =>
      host.store.events.append(latencyRunId, {
        text: hugeAssistantOutput,
        type: "assistant-output",
      })
    );
    await timed(timings, "tool event append", () =>
      host.store.events.append(latencyRunId, {
        output: { text: hugeAssistantOutput },
        toolCallId: "call_latency",
        toolName: "large_tool",
        type: "tool-result",
      })
    );
    await timed(timings, "checkpoint append", () =>
      host.store.checkpoints.append(
        {
          checkpointId: `${latencyRunId}:checkpoint-1`,
          phase: "after-tool",
          runId: latencyRunId,
          runtimeState: { modelOutput: hugeAssistantOutput, next: "model" },
          threadSnapshot: { threadKey: latencyThreadKey, version: "1" },
          version: 1,
        },
        { expectedVersion: 0 }
      )
    );
    await timed(timings, "run update", () =>
      host.store.turns.update({
        ...run,
        checkpointVersion: 1,
        status: "completed",
      })
    );
    await timed(timings, "notification enqueue", () =>
      host.store.notifications.enqueue({
        idempotencyKey: `${latencyRunId}:notification`,
        input: { text: hugeUserInput, type: "user-input" },
        notificationId: `${latencyRunId}:notification`,
        runId: latencyRunId,
        status: "pending",
        threadKey: latencyThreadKey,
      })
    );
    await timed(timings, "scheduler enqueue run", () =>
      host.scheduler.enqueueRun(latencyRunId)
    );
    await timed(timings, "scheduler resume thread", () =>
      host.scheduler.resumeThread(latencyThreadKey, {
        idempotencyKey: `${latencyRunId}:notification`,
        runId: latencyRunId,
      })
    );
    await timed(timings, "thread load", () =>
      host.store.threads.load(latencyThreadKey)
    );
    await timed(timings, "event read", () =>
      collectEventSummaries(host.store.events, latencyRunId)
    );
    await timed(timings, "checkpoint latest", () =>
      host.store.checkpoints.latest(latencyRunId)
    );
    await timed(timings, "notification claim", () =>
      host.store.notifications.claimByIdempotencyKey(
        `${latencyRunId}:notification`
      )
    );

    const summary = summarizeStorageLatencyTimings(timings);
    expect(summary.count).toBe(timings.length);
    expect(summary.maxMs).toBeLessThan(100);
    expect(summary.p95Ms).toBeLessThan(100);
  }, 20_000);
});
