import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { MemoryThreadStore } from "../../platform/memory";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { compactThreadManually } from "../runtime/auto-compaction-runner";
import { ThreadState } from "../state/thread-state";
import { collect, SpyStore } from "./test-support";

const explicitInput = {
  endSeqExclusive: 2,
  startSeq: 0,
  summary: "explicit",
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentThread explicit compaction commit orchestration", () => {
  it("preserves exact input without provider summarization", async () => {
    // Given: one completed turn and a hook observing compaction input.
    const store = new SpyStore();
    let providerCalls = 0;
    const observed: unknown[] = [];
    const thread = new Agent({
      hooks: {
        beforeCompaction: ({ input }) => {
          observed.push(input);
          return { action: "continue" };
        },
      },
      host: hostWithThreads(store),
      model: createCallbackModel(() => {
        providerCalls += 1;
        return [assistantMessage("DONE")];
      }),
    }).thread("explicit-exact-input");
    await collect(await thread.send("history"));

    // When: the explicit overload compacts through the manual runner.
    const compacted = await thread.compact(explicitInput);

    // Then: the input is unchanged and no summary model request occurs.
    expect(compacted).toBe(true);
    expect(observed).toEqual([explicitInput]);
    expect(providerCalls).toBe(1);
    expect(store.threads.get("explicit-exact-input")?.state).toMatchObject({
      compactions: [
        {
          endSeqExclusive: 2,
          startSeq: 0,
          summary: { content: "explicit", role: "system" },
        },
      ],
    });
  });

  it("rejects synchronous expiry at the durable commit boundary", async () => {
    // Given: a hook that crosses the absolute deadline synchronously.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const compaction = Object.assign(() => undefined, {
      deadlineMs: () => 10,
    });
    const thread = new Agent({
      compaction,
      hooks: {
        beforeCompaction: () => {
          vi.setSystemTime(new Date(1010));
          return { action: "continue" };
        },
      },
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    }).thread("explicit-synchronous-expiry");
    await collect(await thread.send("history"));

    // When/Then: no timer delivery is needed to reject before commit starts.
    await expect(thread.compact(explicitInput)).rejects.toMatchObject({
      deadlineAt: 1010,
      deadlineMs: 10,
      reason: "manual",
    });
  });

  it("waits atomically when commit starts before the deadline", async () => {
    // Given: an explicit compaction whose durable commit is in flight.
    vi.useFakeTimers();
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const compaction = Object.assign(() => undefined, {
      deadlineMs: () => 10,
    });
    const thread = new Agent({
      compaction,
      host,
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    }).thread("explicit-atomic-commit");
    await collect(await thread.send("history"));
    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    const originalCommit = store.commit.bind(store);
    vi.spyOn(store, "commit").mockImplementation(async (...args) => {
      commitStarted.resolve();
      await releaseCommit.promise;
      return await originalCommit(...args);
    });

    // When: the deadline expires after the serialized commit has begun.
    let settled = false;
    const compacting = thread.compact(explicitInput).finally(() => {
      settled = true;
    });
    await commitStarted.promise;
    await vi.advanceTimersByTimeAsync(10);

    // Then: the operation waits for one atomic durable outcome.
    expect(settled).toBe(false);
    releaseCommit.resolve();
    await expect(compacting).resolves.toBe(true);
    expect(store.threads.get("explicit-atomic-commit")?.state).toMatchObject({
      compactions: [{ summary: { content: "explicit", role: "system" } }],
    });
  });

  it("times out while waiting behind an active state write", async () => {
    // Given: a preceding write owns the state's serialized write queue.
    vi.useFakeTimers();
    const state = new ThreadState({
      key: "explicit-write-queue",
      store: new MemoryThreadStore(),
    });
    await state.ensureLoaded();
    state.history.appendModelMessage({ content: "history", role: "user" });
    state.history.appendModelMessage(assistantMessage("DONE"));
    const writeStarted = createDeferred();
    const releaseWrite = createDeferred();
    const precedingWrite = state.commitWith(async () => {
      writeStarted.resolve();
      await releaseWrite.promise;
      return { ok: true, version: "1" };
    });
    await writeStarted.promise;

    // When: explicit manual compaction waits behind that write.
    const compacting = compactThreadManually({
      deadlineMs: () => 10,
      explicitInput,
      model: { model: createCallbackModel(() => [assistantMessage("UNUSED")]) },
      state,
      threadKey: "explicit-write-queue",
    });
    const expired = expect(compacting).rejects.toMatchObject({
      deadlineMs: 10,
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(10);

    // Then: expiry prevents the queued compaction from mutating state.
    await expired;
    releaseWrite.resolve();
    await precedingWrite;
    expect(state.compactionSnapshot()).toEqual([]);
  });

  it.each([
    { endSeqExclusive: 3, name: "out-of-bounds", startSeq: 0 },
    { endSeqExclusive: 1, name: "empty-range", startSeq: 1 },
  ])("rejects $name explicit input", async (input) => {
    const thread = new Agent({
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    }).thread(`explicit-invalid-${input.name}`);
    await collect(await thread.send("history"));

    await expect(
      thread.compact({ ...input, summary: "invalid" })
    ).rejects.toThrow("Compaction callback returned an invalid source range.");
  });

  it("keeps invalid manual deadline configuration throwing for explicit input", async () => {
    const compaction = Object.assign(() => undefined, {
      deadlineMs: () => 0,
    });
    const thread = new Agent({
      compaction,
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    }).thread("explicit-invalid-deadline");
    await collect(await thread.send("history"));

    await expect(thread.compact(explicitInput)).rejects.toThrow(
      "Agent compaction deadlineMs() must return a positive safe integer"
    );
  });
});
