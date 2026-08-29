import { describe, expect, it } from "vitest";
import { createDurableObjectStorageHost } from "../../host/storage-host";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import {
  collectEventSummaries,
  oversizedCheckpointText,
  oversizedEventText,
  oversizedThreadText,
  oversizedUserInput,
  payloadBudget,
  prefix,
  runId,
  runRecord,
  threadHistoryTextLength,
  threadKey,
} from "./store-oversized-payload.test-support";
import { countRows } from "./store-stress-assertions";

describe("DurableObjectExecutionStore oversized payload stress", () => {
  it("round-trips large user input, assistant responses, tool output, and checkpoint state", async () => {
    const sql = new InMemorySqlStorage();
    const storage = new InMemoryDurableObjectStorage({ sql });
    const host = createDurableObjectStorageHost({
      maxPayloadBytes: payloadBudget,
      prefix,
      storage,
    });

    const threadCommit = await host.store.threads.commit(
      threadKey,
      {
        state: {
          history: [
            { content: oversizedThreadText, role: "user" },
            { content: oversizedThreadText, role: "assistant" },
          ],
          schemaVersion: 1,
        },
      },
      { expectedVersion: null }
    );
    expect(threadCommit).toEqual({ ok: true, version: "1" });

    const run = runRecord({ runId, threadKey });
    await host.store.turns.create(run);
    await host.store.events.append(runId, {
      text: oversizedEventText,
      type: "assistant-output",
    });
    await host.store.events.append(runId, {
      output: { text: oversizedEventText },
      toolCallId: "call_oversized",
      toolName: "mock_model_output",
      type: "tool-result",
    });
    await host.store.checkpoints.append(
      {
        checkpointId: `${runId}:checkpoint-1`,
        phase: "after-model",
        runId,
        runtimeState: { modelOutput: oversizedCheckpointText },
        threadSnapshot: { threadKey, version: "1" },
        version: 1,
      },
      { expectedVersion: 0 }
    );
    await host.store.turns.update({
      ...run,
      checkpointVersion: 1,
      status: "completed",
    });
    await host.store.notifications.enqueue({
      idempotencyKey: `${runId}:notification`,
      input: { text: oversizedUserInput, type: "user-input" },
      notificationId: `${runId}:notification`,
      runId,
      status: "pending",
      threadKey,
    });

    const loadedThread = await host.store.threads.load(threadKey);
    expect(threadHistoryTextLength(loadedThread?.state, 0)).toBe(
      oversizedThreadText.length
    );
    expect(threadHistoryTextLength(loadedThread?.state, 1)).toBe(
      oversizedThreadText.length
    );
    expect(await collectEventSummaries(host.store.events, runId)).toEqual([
      { textLength: oversizedEventText.length, type: "assistant-output" },
      { outputLength: oversizedEventText.length, type: "tool-result" },
    ]);
    await expect(host.store.checkpoints.latest(runId)).resolves.toMatchObject({
      runtimeState: { modelOutput: oversizedCheckpointText },
      version: 1,
    });
    const claimedNotification =
      await host.store.notifications.claimByIdempotencyKey(
        `${runId}:notification`
      );
    expect(claimedNotification).toMatchObject({
      ok: true,
      record: { input: { text: oversizedUserInput, type: "user-input" } },
    });
    expect(countRows(sql, "pss_thread_message_chunk")).toBeGreaterThan(0);
    expect(countRows(sql, "pss_payload_chunk")).toBeGreaterThan(0);
  }, 20_000);
});
