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
