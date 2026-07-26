import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStore,
  readCompactionRows,
  readRows,
} from "../../platform/cloudflare/storage/sqlite/thread-store.test-support";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import {
  agentWithAutoCompaction,
  storedAssistantOutput,
  tokenCompactionPolicy,
  waitForModelCalls,
} from "./automatic-compaction.test-support";
import { collect, SpyStore } from "./test-support";

describe("Agent thread automatic compaction", () => {
  it("summarizes old history in the background and uses the summary plus latest tail on the next model call", async () => {
    const store = new SpyStore();
    const seenHistory: ModelMessage[][] = [];
    const preparedStepIndices: number[] = [];
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }),
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("old done")];
        }
        if (calls === 2) {
          return [assistantMessage("tail done")];
        }
        if (calls === 3) {
          return [assistantMessage("old exchange summarized")];
        }
        return [assistantMessage("after compaction")];
      }),
      prepareModelStep: ({ runtimeStepIndex }) => {
        preparedStepIndices.push(runtimeStepIndex);
        return;
      },
    });
    const thread = agent.thread("auto");

    await collect(await thread.send("old"));
    await collect(await thread.send("tail"));
    await waitForModelCalls(() => calls, 3);
    expect(preparedStepIndices).toEqual([0, 0]);

    expect(store.threads.get("auto")?.state).toEqual({
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
        storedAssistantOutput("old done"),
        userTextToModelMessage(userText("tail")),
        storedAssistantOutput("tail done"),
      ],
      schemaVersion: 2,
    });

    await collect(await thread.send("next"));
    expect(preparedStepIndices).toEqual([0, 0, 0]);

    expect(seenHistory[3]).toEqual([
      expect.objectContaining({
        content:
          "The conversation history before this point was compacted into the following summary:\n<summary>\nold exchange summarized\n</summary>",
        role: "user",
      }),
      userTextToModelMessage(userText("tail")),
      assistantMessage("tail done"),
      userTextToModelMessage(userText("next")),
    ]);
  });

  it("stores automatic compaction as a SQLite compaction row", async () => {
    const { storage, store } = createStore();
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }),
      host: hostWithThreads(store),
      model: createCallbackModel(() => {
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("sqlite old done")];
        }
        if (calls === 2) {
          return [assistantMessage("sqlite tail done")];
        }
        return [assistantMessage("sqlite summary")];
      }),
    });
    const thread = agent.thread("sqlite-auto");

    await collect(await thread.send("old"));
    await collect(await thread.send("tail"));
    await waitForModelCalls(() => calls, 3);

    expect(readRows(storage, "sqlite-auto")).toHaveLength(4);
    expect(readCompactionRows(storage, "sqlite-auto")).toEqual([
      {
        end_seq_exclusive: 2,
        ordinal: 0,
        start_seq: 0,
        summary: JSON.stringify({
          content: "sqlite summary",
          role: "system",
        }),
      },
    ]);
  });

  it("does not summarize one-turn overlays during automatic compaction", async () => {
    const store = new SpyStore();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: tokenCompactionPolicy({ retain: 20, trigger: 40 }),
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("old done")];
        }
        if (calls === 2) {
          return [assistantMessage("tail done")];
        }
        if (calls === 3) {
          return [assistantMessage("summary without overlay")];
        }
        return [assistantMessage("after compaction")];
      }),
    });
    const thread = agent.thread("overlay-auto");

    await collect(await thread.overlay("volatile context").send("old"));
    await collect(await thread.send("tail"));
    await waitForModelCalls(() => calls, 3);

    expect(seenHistory[0]).toEqual([
      userTextToModelMessage(userText("volatile context")),
      userTextToModelMessage(userText("old")),
    ]);
    expect(JSON.stringify(seenHistory[2])).not.toContain("volatile context");
    expect(store.threads.get("overlay-auto")?.state).toMatchObject({
      compactions: [
        {
          endSeqExclusive: 2,
          schemaVersion: 1,
          startSeq: 0,
          summary: { content: "summary without overlay", role: "system" },
        },
      ],
      history: [
        userTextToModelMessage(userText("old")),
        storedAssistantOutput("old done"),
        userTextToModelMessage(userText("tail")),
        storedAssistantOutput("tail done"),
      ],
      schemaVersion: 2,
    });
  });

  it("closes the triggering turn before the background summary finishes", async () => {
    const store = new SpyStore();
    const summaryStarted = createDeferred();
    const summaryRelease = createDeferred();
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: tokenCompactionPolicy({ retain: 10, trigger: 40 }),
      host: hostWithThreads(store),
      model: createCallbackModel(async () => {
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("first done")];
        }
        if (calls === 2) {
          return [assistantMessage("second done")];
        }
        summaryStarted.resolve();
        await summaryRelease.promise;
        return [assistantMessage("first exchange summarized")];
      }),
    });
    const thread = agent.thread("non-blocking-summary");

    await collect(await thread.send("first"));
    const secondEvents = await collect(await thread.send("second"));

    expect(eventTypes(secondEvents)).toContain("turn-end");
    expect(store.threads.get("non-blocking-summary")?.state).toEqual({
      history: [
        userTextToModelMessage(userText("first")),
        storedAssistantOutput("first done"),
        userTextToModelMessage(userText("second")),
        storedAssistantOutput("second done"),
      ],
      schemaVersion: 1,
    });

    await summaryStarted.promise;
    summaryRelease.resolve();
    await vi.waitFor(() =>
      expect(store.threads.get("non-blocking-summary")?.state).toMatchObject({
        compactions: [
          {
            endSeqExclusive: 2,
            schemaVersion: 1,
            startSeq: 0,
            summary: {
              content: "first exchange summarized",
              role: "system",
            },
          },
        ],
        schemaVersion: 2,
      })
    );
  });
});
