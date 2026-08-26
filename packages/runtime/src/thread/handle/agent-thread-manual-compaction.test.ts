import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { collect, SpyStore } from "./test-support";

describe("AgentThread manual compaction orchestration", () => {
  it("times out while shared startup load continues and remains reusable", async () => {
    vi.useFakeTimers();
    const store = new SpyStore();
    const loadStarted = createDeferred();
    const releaseLoad = createDeferred();
    const originalLoad = store.load.bind(store);
    vi.spyOn(store, "load").mockImplementation(async (key) => {
      loadStarted.resolve();
      await releaseLoad.promise;
      return await originalLoad(key);
    });
    const compaction = Object.assign(() => undefined, {
      deadlineMs: () => 20,
    });
    const thread = new Agent({
      host: hostWithThreads(store),
      compaction,
      model: createCallbackModel(() => [assistantMessage("SUMMARY")]),
    }).thread("manual-startup-load-deadline");
    const admittedAt = Date.now();

    const compacting = thread.compact();
    await loadStarted.promise;
    const expired = expect(compacting).rejects.toMatchObject({
      deadlineAt: admittedAt + 20,
      deadlineMs: 20,
      name: "CompactionDeadlineExceededError",
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(20);
    await expired;
    expect(store.loadCount).toBe(0);

    releaseLoad.resolve();
    await expect(thread.compact()).resolves.toEqual({ status: "empty" });
    expect(store.loadCount).toBe(1);
  });

  it("abandons a pre-aborted shared reservation for later handles", async () => {
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const controller = new AbortController();
    const reason = new TypeError("aborted before compact admission");
    controller.abort(reason);
    const first = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("UNUSED")]),
    }).thread("pre-aborted-shared-reservation");
    const second = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    }).thread("pre-aborted-shared-reservation");

    await expect(first.compact({ signal: controller.signal })).rejects.toBe(
      reason
    );
    await collect(await second.send("healthy history ".repeat(100)));
    await expect(second.compact()).resolves.toEqual({ status: "compacted" });
  });

  it("preserves the public abort reason identity", async () => {
    const controller = new AbortController();
    let calls = 0;
    let markCompactionStarted: (() => void) | undefined;
    const compactionStarted = new Promise<void>((resolve) => {
      markCompactionStarted = resolve;
    });
    const agent = new Agent({
      model: createCallbackModel(({ signal }) => {
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("OLD")];
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          markCompactionStarted?.();
        });
      }),
    });
    const thread = agent.thread("manual-compaction-abort-identity");
    await collect(await thread.send("history"));
    const compacting = thread.compact({ signal: controller.signal });
    await compactionStarted;

    const reason = new TypeError("manual compaction cancelled");
    controller.abort(reason);

    await expect(compacting).rejects.toBe(reason);
  });

  it("times out shared admission without owner release or starving the queue tail", async () => {
    vi.useFakeTimers();
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const ownerStarted = createDeferred();
    const releaseOwner = createDeferred();
    let deadlineCalls = 0;
    const compaction = Object.assign(() => undefined, {
      deadlineMs: () => {
        deadlineCalls += 1;
        return 1000;
      },
    });
    const ownerThread = new Agent({
      host,
      model: createCallbackModel(async () => {
        ownerStarted.resolve();
        await releaseOwner.promise;
        return [assistantMessage("OWNER DONE")];
      }),
    }).thread("manual-compaction-queued-abort");
    const compactingThread = new Agent({
      compaction,
      host,
      model: createCallbackModel(() => [assistantMessage("SUMMARY")]),
    }).thread("manual-compaction-queued-abort");
    const collectingOwner = collect(await ownerThread.send("old ".repeat(200)));
    await ownerStarted.promise;
    const controller = new AbortController();
    const reason = new TypeError("cancelled while queued");
    const compacting = compactingThread.compact({ signal: controller.signal });
    const settled = compacting.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ error, kind: "rejected" as const })
    );
    const guard = new Promise<{ readonly kind: "guard-expired" }>((resolve) => {
      setTimeout(() => resolve({ kind: "guard-expired" }), 1);
    });

    try {
      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(1);

      await expect(Promise.race([settled, guard])).resolves.toEqual({
        error: reason,
        kind: "rejected",
      });
      expect(deadlineCalls).toBe(1);

      const admittedAt = Date.now();
      const expiredCompaction = compactingThread.compact();
      const expiredOutcome = expect(expiredCompaction).rejects.toMatchObject({
        deadlineAt: admittedAt + 1000,
        deadlineMs: 1000,
        name: "CompactionDeadlineExceededError",
        reason: "manual",
      });
      expect(deadlineCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      await expiredOutcome;

      const healthyCompaction = compactingThread.compact();
      expect(deadlineCalls).toBe(3);
      releaseOwner.resolve();
      await collectingOwner;
      await expect(healthyCompaction).resolves.toEqual({ status: "compacted" });
    } finally {
      releaseOwner.resolve();
      await collectingOwner;
      await settled;
      vi.useRealTimers();
    }
  });

  it("abandons a locally expired reservation without breaking shared FIFO", async () => {
    vi.useFakeTimers();
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const firstSummaryStarted = createDeferred();
    const releaseFirstSummary = createDeferred();
    let deadlineCalls = 0;
    let modelCalls = 0;
    const compaction = Object.assign(() => undefined, {
      deadlineMs: () => {
        deadlineCalls += 1;
        return deadlineCalls === 3 ? 20 : 1000;
      },
    });
    const thread = new Agent({
      compaction,
      host,
      model: createCallbackModel(async () => {
        modelCalls += 1;
        if (modelCalls === 2) {
          firstSummaryStarted.resolve();
          await releaseFirstSummary.promise;
        }
        return [assistantMessage("SUMMARY")];
      }),
    }).thread("manual-local-admission-deadline");
    const laterThread = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("LATER")]),
    }).thread("manual-local-admission-deadline");
    await collect(await thread.send("old ".repeat(200)));
    const first = thread.compact();
    await firstSummaryStarted.promise;

    const admittedAt = Date.now();
    const expired = thread.compact();
    expect(deadlineCalls).toBe(3);
    const expiredOutcome = expect(expired).rejects.toMatchObject({
      deadlineAt: admittedAt + 20,
      deadlineMs: 20,
      name: "CompactionDeadlineExceededError",
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(20);
    await expiredOutcome;

    const laterSend = laterThread.send("later healthy input");
    releaseFirstSummary.resolve();
    await expect(first).resolves.toEqual({ status: "compacted" });
    await collect(await laterSend);
    await expect(laterThread.compact()).resolves.toEqual({
      status: "compacted",
    });
    expect(modelCalls).toBe(2);
  });

  it("rejects an invalid configured deadline", async () => {
    const compaction = Object.assign(() => undefined, {
      deadlineMs: () => 0,
    });
    const agent = new Agent({
      compaction,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("invalid-manual-deadline");
    await collect(await thread.send("history"));

    await expect(thread.compact()).rejects.toThrow(
      "Agent compaction deadlineMs() must return a positive safe integer"
    );
  });
});
