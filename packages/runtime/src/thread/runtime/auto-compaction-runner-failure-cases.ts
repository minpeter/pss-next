import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import {
  compactThreadBlocking,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import type { AgentCompaction } from "./auto-compaction-types";

const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

async function stateWithHistory(): Promise<ThreadState> {
  const state = new ThreadState({
    key: "runner-failure-test",
    store: new MemoryThreadStore(),
  });
  await state.ensureLoaded();
  const history: readonly ModelMessage[] = [
    { content: "old", role: "user" },
    assistantMessage("done"),
    { content: "tail", role: "user" },
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  return state;
}

describe("compaction runner failure recovery", () => {
  it("retries one failed completed-turn compaction before the next input", async () => {
    const state = await stateWithHistory();
    let attempts = 0;
    const compaction: AgentCompaction = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("first summary failed");
      }
      return { endSeqExclusive: 2, startSeq: 0, summary: "retried" };
    };

    await scheduleThreadCompaction({
      compaction,
      model,
      state,
      threadKey: "background-retry-success",
    });

    expect(attempts).toBe(2);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "retried", role: "system" } },
    ]);
  });

  it("stops after one background retry and still permits fresh overflow", async () => {
    const state = await stateWithHistory();
    const reasons: string[] = [];
    const compaction: AgentCompaction = async (context) => {
      reasons.push(context.reason);
      if (context.reason === "completed-turn") {
        throw new TypeError("background summary failed");
      }
      return { endSeqExclusive: 2, startSeq: 0, summary: "overflow recovery" };
    };
    const options = {
      compaction,
      model,
      state,
      threadKey: "background-retry-exhaustion",
    };

    await scheduleThreadCompaction(options);
    expect(reasons).toEqual(["completed-turn", "completed-turn"]);

    await expect(compactThreadBlocking(options)).resolves.toBe(true);
    expect(reasons).toEqual([
      "completed-turn",
      "completed-turn",
      "overflow",
    ]);
  });

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
    scheduleThreadCompaction(options);
    releaseFirst.resolve();
    await firstSchedule;

    expect(attempts).toBe(2);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "coalesced", role: "system" } },
    ]);
  });

  it("retries overflow after an active background flight rejects", async () => {
    const state = await stateWithHistory();
    const started = createDeferred();
    const release = createDeferred();
    const reasons: string[] = [];
    const compaction: AgentCompaction = async (context) => {
      reasons.push(context.reason);
      if (context.reason === "completed-turn") {
        started.resolve();
        await release.promise;
        throw new TypeError("background summary failed");
      }
      return { endSeqExclusive: 2, startSeq: 0, summary: "recovered" };
    };
    const options = {
      compaction,
      model,
      state,
      threadKey: "failure-recovery",
    };

    scheduleThreadCompaction(options);
    await started.promise;
    const blocking = compactThreadBlocking(options);
    release.resolve();

    await expect(blocking).resolves.toBe(true);
    expect(reasons).toEqual(["completed-turn", "overflow"]);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "recovered", role: "system" } },
    ]);
  });
});
