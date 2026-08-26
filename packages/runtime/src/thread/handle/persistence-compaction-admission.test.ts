import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { collect, SpyStore } from "./test-support";

describe("Agent thread persistence compaction admission", () => {
  it("rejects same-handle compaction while a turn is active", async () => {
    const releaseModel = createDeferred();
    const modelStarted = createDeferred();
    const agent = new Agent({
      model: createCallbackModel(async () => {
        modelStarted.resolve();
        await releaseModel.promise;
        return [assistantMessage("DONE")];
      }),
    });
    const thread = agent.thread("busy");
    const turn = await thread.send("work");
    const collecting = collect(turn);
    await modelStarted.promise;

    await expect(thread.compact()).rejects.toThrow(
      "Cannot compact while a turn is active."
    );

    releaseModel.resolve();
    await collecting;
  });

  it("waits for another handle's active drain before compaction", async () => {
    const store = new SpyStore();
    const host = hostWithThreads(store);
    const ownerStarted = createDeferred();
    const releaseOwner = createDeferred();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const ownerThread = new Agent({
      host,
      model: createCallbackModel(async () => {
        order.push("owner");
        active += 1;
        maxActive = Math.max(maxActive, active);
        ownerStarted.resolve();
        await releaseOwner.promise;
        active -= 1;
        return [assistantMessage("OWNER DONE")];
      }),
    }).thread("cross-handle-busy");
    const compactingThread = new Agent({
      host,
      model: createCallbackModel(() => {
        order.push("compact");
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        return [assistantMessage("SUMMARY")];
      }),
    }).thread("cross-handle-busy");
    const turn = await ownerThread.send("work ".repeat(200));
    const collecting = collect(turn);
    await ownerStarted.promise;

    const compacting = compactingThread.compact();
    releaseOwner.resolve();
    await collecting;

    await expect(compacting).resolves.toEqual({ status: "compacted" });
    expect(order).toEqual(["owner", "compact"]);
    expect(maxActive).toBe(1);
  });

  it("returns false when beforeCompaction cancels explicit input", async () => {
    const agent = new Agent({
      hooks: {
        beforeCompaction: () => ({ action: "cancel", reason: "policy" }),
      },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("cancel-explicit");
    await collect(await thread.send("history"));

    await expect(
      thread.compact({
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "blocked",
      })
    ).resolves.toBe(false);
  });

  it("keeps compact-before-followUp admission FIFO", async () => {
    const compactionStarted = createDeferred();
    const releaseCompaction = createDeferred();
    const order: string[] = [];
    let gateCompaction = false;
    const model = createCallbackModel(async ({ history }) => {
      const isSummary = history[0]?.role === "system";
      order.push(isSummary ? "compact" : "turn");
      if (gateCompaction && isSummary) {
        compactionStarted.resolve();
        await releaseCompaction.promise;
      }
      return [assistantMessage(isSummary ? "SUMMARY" : "DONE")];
    });
    const thread = new Agent({ model }).thread("same-handle-compact-fifo");
    await collect(await thread.send("old ".repeat(200)));
    order.length = 0;
    gateCompaction = true;

    const compactPromise = thread.compact();
    const followUpPromise = thread.followUp("after compact");
    await compactionStarted.promise;
    releaseCompaction.resolve();
    const [compaction, followUp] = await Promise.all([
      compactPromise,
      followUpPromise,
    ]);
    await collect(followUp);

    expect(compaction).toEqual({ status: "compacted" });
    expect(order).toEqual(["compact", "turn"]);
  });
});
