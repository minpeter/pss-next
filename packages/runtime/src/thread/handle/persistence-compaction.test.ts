import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect, SpyStore } from "./test-support";

const storedAssistantOutput = (text: string): ModelMessage => ({
  content: [{ providerOptions: undefined, text, type: "text" }],
  role: "assistant",
});

describe("Agent thread persistence compaction", () => {
  it("compacts model context without dropping full stored history", async () => {
    const store = new SpyStore();
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(`DONE ${seenHistory.length}`),
        ]);
      }),
    });
    const thread = agent.thread("compact");

    await collect(await thread.send("old"));
    await thread.compact({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "old exchange summarized",
    });
    await collect(await thread.send("tail"));

    expect(seenHistory[1]).toEqual([
      expect.objectContaining({
        content:
          "The conversation history before this point was compacted into the following summary:\n<summary>\nold exchange summarized\n</summary>",
        role: "user",
      }),
      userTextToModelMessage(userText("tail")),
    ]);
    expect(store.threads.get("compact")?.state).toEqual({
      compactions: [
        {
          endSeqExclusive: 2,
          schemaVersion: 1,
          startSeq: 0,
          summary: { content: "old exchange summarized", role: "system" },
        },
      ],
      history: [
        userTextToModelMessage(userText("old")),
        storedAssistantOutput("DONE 1"),
        userTextToModelMessage(userText("tail")),
        storedAssistantOutput("DONE 2"),
      ],
      schemaVersion: 2,
    });
  });

  it("manually compacts through prior summaries, custom instructions, and context hooks", async () => {
    const store = new SpyStore();
    const seenHistory: ModelMessage[][] = [];
    const transformModelContext = vi.fn(() => ({
      action: "continue" as const,
    }));
    const agent = new Agent({
      hooks: { transformModelContext },
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        const isSummary = history.some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.includes("Focus on architectural decisions")
        );
        return Promise.resolve([
          assistantMessage(isSummary ? "combined handoff" : "DONE"),
        ]);
      }),
    });
    const thread = agent.thread("manual-compact");

    await collect(await thread.send("old"));
    await thread.compact({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "prior handoff",
    });
    await collect(await thread.send("newer"));

    await expect(
      thread.compact({ instructions: "Focus on architectural decisions" })
    ).resolves.toEqual({ status: "compacted" });

    const summaryCall = seenHistory.at(-1) ?? [];
    expect(summaryCall[0]).toMatchObject({
      content: expect.stringContaining("## Objective"),
      role: "system",
    });
    expect(summaryCall[0]).toMatchObject({
      content: expect.stringContaining(
        "## Additional focus\nFocus on architectural decisions"
      ),
    });
    expect(summaryCall).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining("prior handoff"),
          role: "user",
        }),
      ])
    );
    expect(transformModelContext).toHaveBeenCalledTimes(3);
    expect(store.threads.get("manual-compact")?.state).toMatchObject({
      compactions: [
        expect.anything(),
        expect.objectContaining({
          endSeqExclusive: 4,
          summary: { content: "combined handoff", role: "system" },
        }),
      ],
    });
  });

  it("reports no-op manual compaction for an empty thread", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("unused")])
      ),
    });

    await expect(agent.thread("empty").compact()).resolves.toEqual({
      status: "empty",
    });
  });

  it("cancels manual compaction through its public signal", async () => {
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
    const thread = agent.thread("cancel-manual-compact");
    await collect(await thread.send("old"));
    const compacting = thread.compact({ signal: controller.signal });
    await compactionStarted;

    controller.abort(new TypeError("manual compaction cancelled"));

    await expect(compacting).rejects.toThrow("manual compaction cancelled");
  });

  it("rejects same-handle manual compaction while a turn is active", async () => {
    let releaseModel: (() => void) | undefined;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let modelStarted = false;
    const agent = new Agent({
      model: createCallbackModel(async () => {
        modelStarted = true;
        await modelGate;
        return [assistantMessage("DONE")];
      }),
    });
    const thread = agent.thread("busy");
    const turn = await thread.send("work");
    const collecting = collect(turn);
    await vi.waitFor(() => expect(modelStarted).toBe(true));

    await expect(thread.compact()).rejects.toThrow(
      "Cannot compact while a turn is active."
    );

    releaseModel?.();
    await collecting;
  });

  it("waits for another handle's active drain before compaction", async () => {
    const store = new SpyStore();
    const host = hostWithThreads(store);
    let releaseOwner: (() => void) | undefined;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let ownerStarted = false;
    let compactionCalls = 0;
    const ownerThread = new Agent({
      host,
      model: createCallbackModel(async () => {
        ownerStarted = true;
        await ownerGate;
        return [assistantMessage("OWNER DONE")];
      }),
    }).thread("cross-handle-busy");
    const compactingThread = new Agent({
      host,
      model: createCallbackModel(() => {
        compactionCalls += 1;
        return [assistantMessage("SUMMARY")];
      }),
    }).thread("cross-handle-busy");
    const turn = await ownerThread.send("work ".repeat(200));
    const collecting = collect(turn);
    await vi.waitFor(() => expect(ownerStarted).toBe(true));

    const compacting = compactingThread.compact();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(compactionCalls).toBe(0);
    releaseOwner?.();
    await collecting;

    await expect(compacting).resolves.toEqual({ status: "compacted" });
    expect(compactionCalls).toBe(1);
  });

  it("returns false when beforeCompaction cancels an explicit input", async () => {
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

  it("keeps same-handle compact-before-followUp admission FIFO", async () => {
    const order: string[] = [];
    const model = createCallbackModel(async ({ history }) => {
      const isSummary = history[0]?.role === "system";
      order.push(isSummary ? "compact" : "turn");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [assistantMessage(isSummary ? "SUMMARY" : "DONE")];
    });
    const thread = new Agent({ model }).thread("same-handle-compact-fifo");
    await collect(await thread.send("old ".repeat(200)));
    order.length = 0;

    const compactPromise = thread.compact();
    const followUpPromise = thread.followUp("after compact");
    const [compaction, followUp] = await Promise.all([
      compactPromise,
      followUpPromise,
    ]);
    await collect(followUp);

    expect(compaction).toEqual({ status: "compacted" });
    expect(order).toEqual(["compact", "turn"]);
  });

  it("refreshes the original owner after another Agent compacts", async () => {
    const store = new SpyStore();
    const host = hostWithThreads(store);
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const ownerHistories: ModelMessage[][] = [];
    const ownerModel = createCallbackModel(async ({ history }) => {
      ownerHistories.push([...history]);
      order.push("turn");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return [assistantMessage(`OWNER ${ownerHistories.length}`)];
    });
    const compactingModel = createCallbackModel(async () => {
      order.push("compact");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
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
