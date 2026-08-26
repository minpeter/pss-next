import { describe, expect, it } from "vitest";
import { createDeferred } from "../../testing/test-fixtures";
import {
  compactThreadBlocking,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-failure-test-support";
import type { AgentCompaction } from "./auto-compaction-types";

describe("compaction runner failure recovery", () => {
  it("retries one failed completed-turn compaction before the next input", async () => {
    const state = await stateWithHistory();
    let attempts = 0;
    const compaction: AgentCompaction = () => {
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
    const compaction: AgentCompaction = (context) => {
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
    expect(reasons).toEqual(["completed-turn", "completed-turn", "overflow"]);
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
