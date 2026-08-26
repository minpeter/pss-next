import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { collect, SpyStore } from "./test-support";
import { withThreadDrainOwnership } from "./thread-drain-coordinator";

const explicitInput = {
  endSeqExclusive: 2,
  startSeq: 0,
  summary: "explicit",
} as const;

const deadlinePolicy = Object.assign(() => undefined, {
  deadlineMs: () => 10,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentThread explicit compaction boundaries", () => {
  it("times out while startup remains hung", async () => {
    // Given: persisted history and a new handle blocked in startup loading.
    vi.useFakeTimers();
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const owner = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    });
    await collect(await owner.thread("explicit-startup").send("history"));
    const loadStarted = createDeferred();
    const releaseLoad = createDeferred();
    const originalLoad = store.load.bind(store);
    vi.spyOn(store, "load").mockImplementation(async (key) => {
      loadStarted.resolve();
      await releaseLoad.promise;
      return await originalLoad(key);
    });
    const thread = new Agent({
      compaction: deadlinePolicy,
      host,
      model: createCallbackModel(() => [assistantMessage("UNUSED")]),
    }).thread("explicit-startup");

    // When: explicit compaction reaches the shared startup operation.
    const compacting = thread.compact(explicitInput);
    await loadStarted.promise;
    const expired = expect(compacting).rejects.toMatchObject({
      deadlineMs: 10,
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(10);

    // Then: startup may continue, but this caller is bounded.
    await expired;
    releaseLoad.resolve();
  });

  it("times out while durable claim recovery remains hung", async () => {
    // Given: a loaded hosted thread whose claim recovery never settles.
    vi.useFakeTimers();
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const owner = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    });
    await collect(await owner.thread("explicit-claims").send("history"));
    const commitsBeforeCompaction = store.commits.length;
    const recoveryStarted = createDeferred();
    const releaseRecovery = createDeferred();
    vi.spyOn(host.store.inputs, "recoverClaims").mockImplementation(
      async () => {
        recoveryStarted.resolve();
        await releaseRecovery.promise;
        return { acked: [], released: [] };
      }
    );
    const thread = new Agent({
      compaction: deadlinePolicy,
      host,
      model: createCallbackModel(() => [assistantMessage("UNUSED")]),
    }).thread("explicit-claims");

    // When: explicit compaction reaches hosted recovery.
    const compacting = thread.compact(explicitInput);
    await recoveryStarted.promise;
    const expired = expect(compacting).rejects.toMatchObject({
      deadlineMs: 10,
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(10);

    // Then: recovery is deadline-bounded and cannot commit afterward.
    await expired;
    releaseRecovery.resolve();
    await vi.runAllTimersAsync();
    expect(store.commits).toHaveLength(commitsBeforeCompaction);
  });

  it("times out while shared drain ownership remains hung", async () => {
    // Given: history and drain ownership held outside input admission.
    vi.useFakeTimers();
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const setup = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    });
    await collect(await setup.thread("explicit-drain").send("history"));
    const ownerStarted = createDeferred();
    const releaseOwner = createDeferred();
    const ownership = withThreadDrainOwnership(
      host,
      "explicit-drain",
      {},
      async () => {
        ownerStarted.resolve();
        await releaseOwner.promise;
      }
    );
    await ownerStarted.promise;
    const thread = new Agent({
      compaction: deadlinePolicy,
      host,
      model: createCallbackModel(() => [assistantMessage("UNUSED")]),
    }).thread("explicit-drain");

    // When: explicit compaction waits for drain ownership.
    const compacting = thread.compact(explicitInput);
    const expired = expect(compacting).rejects.toMatchObject({
      deadlineMs: 10,
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(10);

    // Then: the timed-out reservation releases and a healthy caller can follow.
    await expired;
    const healthy = thread.compact(explicitInput);
    releaseOwner.resolve();
    await ownership;
    await expect(healthy).resolves.toBe(true);
  });

  it("times out while stale-owner refresh remains hung", async () => {
    // Given: another owner has made an established handle stale.
    vi.useFakeTimers();
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const first = new Agent({
      compaction: deadlinePolicy,
      host,
      model: createCallbackModel(() => [assistantMessage("FIRST")]),
    }).thread("explicit-refresh");
    await collect(await first.send("history"));
    await expect(first.compact(explicitInput)).resolves.toBe(true);
    const second = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("SECOND")]),
    }).thread("explicit-refresh");
    await collect(await second.send("new owner"));
    const refreshStarted = createDeferred();
    const releaseRefresh = createDeferred();
    const originalLoad = store.load.bind(store);
    vi.spyOn(store, "load").mockImplementation(async (key) => {
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return await originalLoad(key);
    });

    // When: the stale handle tries explicit compaction again.
    const compacting = first.compact({
      ...explicitInput,
      endSeqExclusive: 4,
    });
    await refreshStarted.promise;
    const expired = expect(compacting).rejects.toMatchObject({
      deadlineMs: 10,
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(10);

    // Then: refresh is included in the same absolute deadline.
    await expired;
    releaseRefresh.resolve();
  });
});
