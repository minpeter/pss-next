import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../testing/test-fixtures";
import type { ThreadCompactionInput } from "../state/thread-state";
import { scheduleThreadCompaction } from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-failure-test-support";
import type { AgentCompaction } from "./auto-compaction-types";

describe("compaction runner failure recovery", () => {
  it("coalesces a pending completed-turn schedule with the retry", async () => {
    const state = await stateWithHistory();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    let attempts = 0;
    const compaction: AgentCompaction = async () => {
      attempts += 1;
      if (attempts === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        throw new TypeError("first summary failed");
      }
      return { endSeqExclusive: 2, startSeq: 0, summary: "coalesced" };
    };
    const options = {
      compaction,
      model,
      state,
      threadKey: "background-retry-coalescing",
    };

    const firstSchedule = scheduleThreadCompaction(options);
    await firstStarted.promise;
    const pendingSchedule = scheduleThreadCompaction(options);
    releaseFirst.resolve();
    await Promise.all([firstSchedule, pendingSchedule]);

    expect(attempts).toBe(2);
    expect(state.compactionSnapshot()).toHaveLength(1);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "coalesced", role: "system" } },
    ]);
  });

  it("uses pending options for the active completed-turn retry", async () => {
    const state = await stateWithHistory();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    let activeAttempts = 0;
    const activeCompaction = vi.fn<AgentCompaction>(async () => {
      activeAttempts += 1;
      if (activeAttempts === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        throw new TypeError("first summary failed");
      }
      return {
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "wrong active retry",
      };
    });
    const pendingCompaction = vi.fn<AgentCompaction>(() => ({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "pending retry",
    }));

    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "background-retry-latest-options",
    });
    await firstStarted.promise;
    const pending = scheduleThreadCompaction({
      compaction: pendingCompaction,
      model,
      state,
      threadKey: "background-retry-latest-options",
    });
    releaseFirst.resolve();
    await Promise.all([active, pending]);

    expect(activeCompaction).toHaveBeenCalledTimes(1);
    expect(pendingCompaction).toHaveBeenCalledTimes(1);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "pending retry", role: "system" } },
    ]);
  });

  it("restores covered pending work after the active retry rejects", async () => {
    const state = await stateWithHistory();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const freshPendingStarted = createDeferred();
    const releaseFreshPending = createDeferred();
    const activeCompaction = vi.fn<AgentCompaction>(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new TypeError("active attempt failed");
    });
    let pendingAttempts = 0;
    const pendingCompaction = vi.fn<AgentCompaction>(async () => {
      pendingAttempts += 1;
      if (pendingAttempts === 1) {
        throw new TypeError("covered retry failed");
      }
      freshPendingStarted.resolve();
      await releaseFreshPending.promise;
      return {
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "fresh pending",
      };
    });

    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "failed-covered-retry",
    });
    await firstStarted.promise;
    const pending = scheduleThreadCompaction({
      compaction: pendingCompaction,
      model,
      state,
      threadKey: "failed-covered-retry",
    });
    let pendingSettled = false;
    pending.finally(() => {
      pendingSettled = true;
    });
    releaseFirst.resolve();

    await freshPendingStarted.promise;
    await active;
    expect(pendingAttempts).toBe(2);
    expect(pendingSettled).toBe(false);
    expect(state.compactionSnapshot()).toEqual([]);

    releaseFreshPending.resolve();
    await pending;
    expect(pendingSettled).toBe(true);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "fresh pending", role: "system" } },
    ]);
  });

  it("keeps a schedule arriving during the active retry as separate work", async () => {
    const state = await stateWithHistory();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const coveredRetryStarted = createDeferred();
    const releaseCoveredRetry = createDeferred();
    let activeAttempts = 0;
    const activeCompaction = vi.fn<AgentCompaction>(async () => {
      activeAttempts += 1;
      if (activeAttempts === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        throw new TypeError("active attempt failed");
      }
      throw new TypeError("active policy must not supply retry");
    });
    const coveredCompaction = vi.fn<AgentCompaction>(
      async (): Promise<ThreadCompactionInput | undefined> => {
        coveredRetryStarted.resolve();
        await releaseCoveredRetry.promise;
        return;
      }
    );
    const duringRetryCompaction = vi.fn<AgentCompaction>(() => ({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "during retry pending",
    }));

    const active = scheduleThreadCompaction({
      compaction: activeCompaction,
      model,
      state,
      threadKey: "during-covered-retry",
    });
    await firstStarted.promise;
    const covered = scheduleThreadCompaction({
      compaction: coveredCompaction,
      model,
      state,
      threadKey: "during-covered-retry",
    });
    releaseFirst.resolve();
    await coveredRetryStarted.promise;
    const duringRetry = scheduleThreadCompaction({
      compaction: duringRetryCompaction,
      model,
      state,
      threadKey: "during-covered-retry",
    });
    releaseCoveredRetry.resolve();

    await Promise.all([active, covered, duringRetry]);
    expect(activeCompaction).toHaveBeenCalledTimes(1);
    expect(coveredCompaction).toHaveBeenCalledTimes(1);
    expect(duringRetryCompaction).toHaveBeenCalledTimes(1);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "during retry pending", role: "system" } },
    ]);
  });
});
