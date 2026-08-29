import { describe, expect, it } from "vitest";
import {
  ackScheduledDurableObjectRun,
  ackScheduledDurableObjectThreadPrompt,
  createDurableObjectStorageHost,
  listScheduledDurableObjectRuns,
  listScheduledDurableObjectThreadPrompts,
} from "../../host/storage-host";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import { countRows, sumChunkBytes } from "./store-stress-assertions";
import {
  extremeAwareTimeout,
  isExtremeStorageStressProfile,
  mockAgentStressConfig,
} from "./store-stress-config";
import {
  eventRecord,
  hostLoadFinalThread,
  runRecord,
} from "./store-stress-helpers";
import { runMockAgentStorageScenario } from "./store-stress-scenario";

const stressThreadCount = 24;
const stressTurnsPerThread = 32;
const stressRunsPerThread = 8;

describe("DurableObjectExecutionStore storage stress", () => {
  it(
    "persists a mock multi-user agent workload locally without LLM execution",
    async () => {
      const sql = new InMemorySqlStorage();
      const storage = new InMemoryDurableObjectStorage({ sql });
      const config = mockAgentStressConfig;

      const result = await runMockAgentStorageScenario(storage, config);

      await expect(
        hostLoadFinalThread(storage, config.prefix, result.finalThreadKey)
      ).resolves.toMatchObject({ version: result.finalThreadVersion });
      expect(countRows(sql, "pss_thread_meta")).toBe(result.threads);
      expect(countRows(sql, "pss_thread_message")).toBe(result.threadMessages);
      expect(countRows(sql, "pss_thread_message_chunk")).toBeGreaterThan(0);
      expect(countRows(sql, "pss_run")).toBe(result.turns);
      expect(countRows(sql, "pss_event")).toBe(result.turns * 2);
      expect(countRows(sql, "pss_checkpoint")).toBe(result.turns);
      expect(countRows(sql, "pss_notification")).toBe(result.notifications);
      expect(countRows(sql, "pss_scheduled_work")).toBe(
        result.notifications * 2
      );
      if (config.targetStoredChunkBytes > 0) {
        expect(sumChunkBytes(sql)).toBeGreaterThanOrEqual(
          config.targetStoredChunkBytes
        );
      }

      for (const runId of await listScheduledDurableObjectRuns(storage, {
        prefix: config.prefix,
      })) {
        await ackScheduledDurableObjectRun(storage, runId, {
          prefix: config.prefix,
        });
      }
      for (const prompt of await listScheduledDurableObjectThreadPrompts(
        storage,
        {
          prefix: config.prefix,
        }
      )) {
        await ackScheduledDurableObjectThreadPrompt(storage, prompt, {
          prefix: config.prefix,
        });
      }
      expect(countRows(sql, "pss_scheduled_work")).toBe(0);
    },
    extremeAwareTimeout(120_000)
  );

  const genericStressIt = isExtremeStorageStressProfile ? it.skip : it;

  genericStressIt(
    "stores many thread, run, event, checkpoint, notification, and scheduled rows without LLM execution",
    async () => {
      const storage = new InMemoryDurableObjectStorage({
        sql: new InMemorySqlStorage(),
      });
      const host = createDurableObjectStorageHost({
        prefix: "stress-runtime",
        storage,
      });

      for (
        let threadIndex = 0;
        threadIndex < stressThreadCount;
        threadIndex += 1
      ) {
        const threadKey = `thread-${threadIndex}`;
        let expectedVersion: string | null = null;
        const history: unknown[] = [];

        for (
          let turnIndex = 0;
          turnIndex < stressTurnsPerThread;
          turnIndex += 1
        ) {
          history.push({
            content: `user ${threadIndex}:${turnIndex}`,
            role: "user",
          });
          history.push({
            content: `assistant ${threadIndex}:${turnIndex}`,
            role: "assistant",
          });
          const result = await host.store.threads.commit(
            threadKey,
            { state: { history: [...history], schemaVersion: 1 } },
            { expectedVersion }
          );
          expect(result.ok).toBe(true);
          if (result.ok) {
            expectedVersion = result.version;
          }
        }

        for (let runIndex = 0; runIndex < stressRunsPerThread; runIndex += 1) {
          const runId = `${threadKey}:run-${runIndex}`;
          const run = runRecord({ runId, threadKey });
          await host.store.turns.create(run);
          await host.store.events.append(runId, eventRecord("step-start"));
          await host.store.events.append(runId, eventRecord("step-end"));
          await host.store.checkpoints.append(
            {
              checkpointId: `${runId}:checkpoint-1`,
              phase: "before-model",
              runId,
              runtimeState: { runIndex },
              threadSnapshot: { threadKey, version: expectedVersion },
              version: 1,
            },
            { expectedVersion: 0 }
          );
          await host.store.turns.update({
            ...run,
            checkpointVersion: 1,
            status: "completed",
          });
          const notificationKey = `${runId}:notify`;
          await host.store.notifications.enqueue({
            idempotencyKey: notificationKey,
            input: { text: `notify ${runId}`, type: "user-input" },
            notificationId: `${runId}:notification`,
            runId,
            status: "pending",
            threadKey,
          });
          await host.store.notifications.claimByIdempotencyKey(notificationKey);
          await host.scheduler.enqueueRun(runId);
          await host.scheduler.resumeThread(threadKey, {
            idempotencyKey: notificationKey,
            runId,
          });
        }
      }

      await expect(
        host.store.threads.load(`thread-${stressThreadCount - 1}`)
      ).resolves.toMatchObject({ version: String(stressTurnsPerThread) });
      await expect(
        host.store.turns.listByParentRunId("missing-parent")
      ).resolves.toEqual([]);
      await expect(
        listScheduledDurableObjectRuns(storage, {
          limit: stressThreadCount * stressRunsPerThread,
          prefix: "stress-runtime",
        })
      ).resolves.toHaveLength(stressThreadCount * stressRunsPerThread);
      await expect(
        listScheduledDurableObjectThreadPrompts(storage, {
          limit: stressThreadCount * stressRunsPerThread,
          prefix: "stress-runtime",
        })
      ).resolves.toHaveLength(stressThreadCount * stressRunsPerThread);

      for (const runId of await listScheduledDurableObjectRuns(storage, {
        prefix: "stress-runtime",
      })) {
        await ackScheduledDurableObjectRun(storage, runId, {
          prefix: "stress-runtime",
        });
      }
      for (const prompt of await listScheduledDurableObjectThreadPrompts(
        storage,
        {
          prefix: "stress-runtime",
        }
      )) {
        await ackScheduledDurableObjectThreadPrompt(storage, prompt, {
          prefix: "stress-runtime",
        });
      }
      await expect(
        listScheduledDurableObjectRuns(storage, { prefix: "stress-runtime" })
      ).resolves.toEqual([]);
      await expect(
        listScheduledDurableObjectThreadPrompts(storage, {
          prefix: "stress-runtime",
        })
      ).resolves.toEqual([]);
    },
    20_000
  );
});
