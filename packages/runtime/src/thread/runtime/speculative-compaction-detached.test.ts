import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactThreadBlocking,
  compactThreadManually,
} from "./auto-compaction-runner";
import type { AgentCompactionContext } from "./auto-compaction-types";
import {
  DEADLINE_MS,
  hangingSummaryProvider,
  policy,
  stateWithHistory,
} from "./speculative-compaction-detached-test-support";
import { context, message } from "./speculative-compaction-test-support";

afterEach(() => {
  vi.useRealTimers();
});

describe("speculativeCompaction detached summaries", () => {
  it("keeps an in-flight summary running past the deadline and commits it on the next episode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const state = await stateWithHistory("detached-deadline-convergence");
    const { model, provider } = hangingSummaryProvider();
    const options = {
      compaction: policy(),
      model,
      state,
      threadKey: "detached-deadline-convergence",
    };

    const first = compactThreadBlocking(options);
    const firstSettled = expect(first).rejects.toMatchObject({
      deadlineMs: DEADLINE_MS,
      name: "CompactionDeadlineExceededError",
      reason: "overflow",
    });
    await provider.started.promise;
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await firstSettled;

    expect(provider.called).toBe(1);
    expect(provider.signal?.aborted).toBe(false);

    provider.firstGate.resolve();
    const second = await compactThreadBlocking(options);

    expect(second).toBe(true);
    expect(provider.called).toBe(1);
    expect(state.compactionSnapshot()).toHaveLength(1);
    expect(JSON.stringify(state.compactionSnapshot())).toContain(
      "detached summary 1"
    );
  });

  it("joins a second blocking episode to the same detached summary call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const state = await stateWithHistory("detached-single-flight");
    const { model, provider } = hangingSummaryProvider();
    const options = {
      compaction: policy(),
      model,
      state,
      threadKey: "detached-single-flight",
    };

    const first = compactThreadBlocking(options);
    const firstSettled = expect(first).rejects.toMatchObject({
      name: "CompactionDeadlineExceededError",
    });
    await provider.started.promise;
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await firstSettled;

    const second = compactThreadBlocking(options);
    provider.firstGate.resolve();

    await expect(second).resolves.toBe(true);
    expect(provider.called).toBe(1);
    expect(state.compactionSnapshot()).toHaveLength(1);
  });

  it("refuses a detached result that went stale before its next use", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const state = await stateWithHistory("detached-stale");
    const { model, provider } = hangingSummaryProvider();
    const options = {
      compaction: policy(),
      model,
      state,
      threadKey: "detached-stale",
    };

    const first = compactThreadBlocking(options);
    const firstSettled = expect(first).rejects.toMatchObject({
      name: "CompactionDeadlineExceededError",
    });
    await provider.started.promise;
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await firstSettled;
    expect(provider.called).toBe(1);

    const manual = await compactThreadManually({
      explicitInput: { endSeqExclusive: 2, startSeq: 0, summary: "manual" },
      model,
      state,
      threadKey: "detached-stale",
    });
    expect(manual).toBe(true);
    expect(state.compactionSnapshot()).toHaveLength(1);

    provider.firstGate.resolve();
    const second = await compactThreadBlocking(options);

    expect(second).toBe(true);
    expect(provider.called).toBe(2);
    const records = state.compactionSnapshot();
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records[0])).toContain("manual");
    expect(JSON.stringify(records[1])).toContain("detached summary 2");
  });
  it("lets only the current detached job install after a drifted job replaces it", async () => {
    const firstHistory = Array.from({ length: 6 }, (_, index) =>
      message(`A-${index}`, index % 2 === 0 ? "user" : "assistant")
    );
    const secondHistory = Array.from({ length: 6 }, (_, index) =>
      message(`B-${index}`, index % 2 === 0 ? "user" : "assistant")
    );
    let resolveFirst: (summary: string) => void = () => {
      throw new TypeError("first summary promise was not initialized");
    };
    let resolveSecond: (summary: string) => void = () => {
      throw new TypeError("second summary promise was not initialized");
    };
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<string>((resolve) => {
      resolveSecond = resolve;
    });
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockResolvedValueOnce("unexpected fresh summary");
    const compaction = policy();

    const pendingFirst = compaction(context(firstHistory, summarize));
    const pendingSecond = compaction(context(secondHistory, summarize));
    expect(summarize).toHaveBeenCalledTimes(2);

    resolveFirst("candidate A");
    await pendingFirst;
    resolveSecond("candidate B");
    await pendingSecond;
    const promoted = await compaction(
      context([...secondHistory, message("tail")], summarize, {
        reason: "overflow",
      })
    );

    expect(promoted?.summary).toBe("candidate B");
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("refuses a direct detached result when its source snapshot drifts", async () => {
    const history = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );
    let resolveSummary: (summary: string) => void = () => {
      throw new TypeError("summary promise was not initialized");
    };
    const summary = new Promise<string>((resolve) => {
      resolveSummary = resolve;
    });
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockReturnValue(summary);
    const compaction = policy();
    const pending = compaction(
      context(history, summarize, { reason: "overflow" })
    );
    expect(summarize).toHaveBeenCalledTimes(1);

    history[0] = message("changed");
    resolveSummary("stale summary");

    await expect(Promise.resolve(pending)).resolves.toBeUndefined();
  });

  it("does not join a detached summary from another transformed model context", async () => {
    const history = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );
    let resolveA: (summary: string) => void = () => {
      throw new TypeError("summary A promise was not initialized");
    };
    let resolveB: (summary: string) => void = () => {
      throw new TypeError("summary B promise was not initialized");
    };
    const summaryA = new Promise<string>((resolve) => {
      resolveA = resolve;
    });
    const summaryB = new Promise<string>((resolve) => {
      resolveB = resolve;
    });
    const summarizeA = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockReturnValue(summaryA);
    const summarizeB = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockReturnValue(summaryB);
    const compaction = policy();

    const pendingA = compaction(
      context(history, summarizeA, {
        modelContext: [{ content: "CONTEXT_A", role: "system" }, ...history],
        modelContextProvenance: "transformed",
        reason: "overflow",
      })
    );
    const pendingB = compaction(
      context(history, summarizeB, {
        modelContext: [{ content: "CONTEXT_B", role: "system" }, ...history],
        modelContextProvenance: "transformed",
        reason: "overflow",
      })
    );

    expect(summarizeA).toHaveBeenCalledTimes(1);
    expect(summarizeB).toHaveBeenCalledTimes(1);
    resolveA("SUMMARY_A");
    resolveB("SUMMARY_B");

    await expect(Promise.resolve(pendingA)).resolves.toMatchObject({
      summary: "SUMMARY_A",
    });
    await expect(Promise.resolve(pendingB)).resolves.toMatchObject({
      summary: "SUMMARY_B",
    });
  });
});
