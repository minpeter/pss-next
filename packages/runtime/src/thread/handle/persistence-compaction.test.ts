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

  it("rejects manual compaction while a turn is active", async () => {
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
});
