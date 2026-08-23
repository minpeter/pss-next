import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { CompactionDeadlineExceededError } from "../runtime/auto-compaction-episode";
import type { AgentCompaction } from "../runtime/auto-compaction-types";
import { collect, SpyStore } from "./test-support";

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentThread manual compaction deadline", () => {
  it("bounds an explicit input when beforeCompaction never settles", async () => {
    // Given: a completed turn and an explicit compaction blocked in its hook.
    vi.useFakeTimers();
    const hookStarted = createDeferred();
    const compaction = Object.assign(() => undefined, {
      deadlineMs: () => 10,
    });
    const thread = new Agent({
      compaction,
      hooks: {
        beforeCompaction: async () => {
          hookStarted.resolve();
          return await new Promise<never>(() => undefined);
        },
      },
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    }).thread("explicit-input-hook-deadline");
    await collect(await thread.send("history"));

    // When: the public explicit-input overload reaches the hung hook.
    const compacting = thread.compact({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "explicit",
    });
    await hookStarted.promise;
    const outcome = Promise.race([
      compacting,
      new Promise<"race-timeout">((resolve) => {
        setTimeout(() => resolve("race-timeout"), 50);
      }),
    ]);
    const expired = expect(outcome).rejects.toMatchObject({
      deadlineMs: 10,
      name: "CompactionDeadlineExceededError",
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(50);

    // Then: the admission-time manual deadline wins the bounded race.
    await expired;
  });

  it("releases timed-out preparation without allowing detached mutation", async () => {
    // Given: a stale handle blocks while refreshing under manual ownership.
    vi.useFakeTimers();
    const store = new SpyStore();
    const host = hostWithThreads(store);
    let providerCalls = 0;
    const compaction = Object.assign(() => undefined, {
      deadlineMs: () => 20,
    });
    const compactingThread = new Agent({
      compaction,
      host,
      model: createCallbackModel(() => {
        providerCalls += 1;
        return [assistantMessage("SUMMARY")];
      }),
    }).thread("manual-preparation-deadline");
    await expect(compactingThread.compact()).resolves.toEqual({
      status: "empty",
    });
    const ownerThread = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("OWNER")]),
    }).thread("manual-preparation-deadline");
    await collect(await ownerThread.send("history ".repeat(100)));
    const commitsBeforePreparation = store.commits.length;
    const releaseRefresh = createDeferred();
    const firstRefreshStarted = createDeferred();
    const secondRefreshStarted = createDeferred();
    const originalLoad = store.load.bind(store);
    let blockedLoads = 0;
    store.loadGate = releaseRefresh.promise;
    vi.spyOn(store, "load").mockImplementation(async (key) => {
      blockedLoads += 1;
      if (blockedLoads === 1) {
        firstRefreshStarted.resolve();
      } else if (blockedLoads === 2) {
        secondRefreshStarted.resolve();
      }
      return await originalLoad(key);
    });
    const expired = compactingThread.compact();
    await firstRefreshStarted.promise;
    const expiredOutcome = expect(expired).rejects.toMatchObject({
      deadlineMs: 20,
      name: "CompactionDeadlineExceededError",
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(20);
    await expiredOutcome;

    // When: a later compaction requests ownership before refresh unblocks.
    const healthy = compactingThread.compact();
    const acquiredBeforeGuard = Promise.race([
      secondRefreshStarted.promise.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 1);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(1);
    const acquired = await acquiredBeforeGuard;
    releaseRefresh.resolve();
    const healthyResult = await healthy;

    // Then: ownership was released, and only the healthy caller mutates state.
    expect(acquired).toBe(true);
    expect(healthyResult).toEqual({ status: "compacted" });
    expect(providerCalls).toBe(1);
    expect(store.commits).toHaveLength(commitsBeforePreparation + 1);
  });

  it("inherits the configured compaction deadline without invoking its policy", async () => {
    const automaticCompleted = createDeferred();
    const manualSummaryStarted = createDeferred();
    const cleanup = new AbortController();
    let modelCalls = 0;
    let policyCalls = 0;
    let deadlineCalls = 0;
    const compaction = Object.assign(
      (): undefined => {
        policyCalls += 1;
        automaticCompleted.resolve();
        return;
      },
      {
        deadlineMs: () => {
          deadlineCalls += 1;
          return 25;
        },
      }
    ) satisfies AgentCompaction;
    const agent = new Agent({
      compaction,
      model: createCallbackModel(({ signal }) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return [assistantMessage("OLD")];
        }
        manualSummaryStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    });
    const thread = agent.thread("manual-custom-deadline");
    await collect(await thread.send("old ".repeat(200)));
    await automaticCompleted.promise;
    vi.useFakeTimers();
    const policyCallsBeforeManual = policyCalls;
    let outcome: unknown;
    const compacting = thread.compact({ signal: cleanup.signal }).then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      }
    );

    try {
      await manualSummaryStarted.promise;
      await vi.advanceTimersByTimeAsync(25);

      expect(outcome).toBeInstanceOf(CompactionDeadlineExceededError);
      expect(policyCalls).toBe(policyCallsBeforeManual);
      expect(deadlineCalls).toBe(2);
    } finally {
      cleanup.abort(new Error("test cleanup"));
      await compacting;
    }
  });
});
