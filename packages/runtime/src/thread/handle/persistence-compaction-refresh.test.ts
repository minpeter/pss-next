import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { collect, SpyStore } from "./test-support";

describe("Agent thread persistence compaction refresh", () => {
  it("refreshes the original owner after another Agent compacts", async () => {
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const compactionStarted = createDeferred();
    const releaseCompaction = createDeferred();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const ownerHistories: ModelMessage[][] = [];
    const ownerModel = createCallbackModel(({ history }) => {
      ownerHistories.push([...history]);
      order.push("turn");
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return [assistantMessage(`OWNER ${ownerHistories.length}`)];
    });
    const compactingModel = createCallbackModel(async () => {
      order.push("compact");
      active += 1;
      maxActive = Math.max(maxActive, active);
      compactionStarted.resolve();
      await releaseCompaction.promise;
      active -= 1;
      return [assistantMessage("SHARED SUMMARY")];
    });
    const ownerThread = new Agent({ host, model: ownerModel }).thread(
      "shared-compact-fifo"
    );
    await collect(await ownerThread.send("old ".repeat(200)));
    order.length = 0;
    const compactingThread = new Agent({
      host,
      model: compactingModel,
    }).thread("shared-compact-fifo");

    const compactPromise = compactingThread.compact();
    const followUpPromise = ownerThread.followUp("after shared compact");
    await compactionStarted.promise;
    releaseCompaction.resolve();
    const [compaction, followUp] = await Promise.all([
      compactPromise,
      followUpPromise,
    ]);
    const followUpEvents = await collect(followUp);
    const sendEvents = await collect(await ownerThread.send("after follow-up"));

    expect(compaction).toEqual({ status: "compacted" });
    expect(order).toEqual(["compact", "turn", "turn"]);
    expect(maxActive).toBe(1);
    expect(followUpEvents.at(-1)?.type).toBe("turn-end");
    expect(sendEvents.at(-1)?.type).toBe("turn-end");
    expect(JSON.stringify(ownerHistories[1])).toContain("SHARED SUMMARY");
    expect(JSON.stringify(ownerHistories[1])).toContain("after shared compact");
    expect(JSON.stringify(ownerHistories[2])).toContain("after follow-up");
    expect(store.threads.get("shared-compact-fifo")?.state).toMatchObject({
      compactions: [
        {
          summary: { content: "SHARED SUMMARY", role: "system" },
        },
      ],
    });
  });
});
