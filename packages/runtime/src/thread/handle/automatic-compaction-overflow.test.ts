import { jsonSchema, type ModelMessage, tool } from "ai";
import { describe, expect, it } from "vitest";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  toolCallPart,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import {
  agentWithCompaction,
  storedAssistantOutput,
  tokenCompactionPolicy,
} from "./automatic-compaction.test-support";
import { collect, SpyStore } from "./test-support";

describe("Agent thread automatic compaction overflow recovery", () => {
  it("blocks for compaction and retries once when the model overflows context", async () => {
    const store = new SpyStore();
    const retryHistory: ModelMessage[][] = [];
    let calls = 0;
    const preparedStepIndices: number[] = [];
    const agent = agentWithCompaction({
      compaction: tokenCompactionPolicy({ retain: 20, trigger: 50 }),
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("old done")];
        }
        if (calls === 2) {
          return [assistantMessage("tail done")];
        }
        if (calls === 3) {
          throw new Error("context_length_exceeded: too many tokens");
        }
        if (calls === 4) {
          return [assistantMessage("old exchange summarized")];
        }
        retryHistory.push([...history]);
        return [assistantMessage("after blocking compaction")];
      }),
      prepareModelStep: ({ runtimeStepIndex }) => {
        preparedStepIndices.push(runtimeStepIndex);
        return;
      },
    });
    const thread = agent.thread("blocking-overflow");

    await collect(await thread.send("old"));
    await collect(await thread.send("tail"));
    const events = await collect(await thread.send("next"));

    expect(eventTypes(events)).toContain("turn-end");
    expect(eventTypes(events).filter((type) => type === "model-usage")).toEqual(
      ["model-usage"]
    );
    expect(events).toContainEqual({
      text: "after blocking compaction",
      type: "assistant-output",
    });
    expect(preparedStepIndices).toEqual([0, 0, 0, 0]);
    expect(retryHistory[0]).toEqual([
      expect.objectContaining({
        content:
          "The conversation history before this point was compacted into the following summary:\n<summary>\nold exchange summarized\n</summary>",
        role: "user",
      }),
      userTextToModelMessage(userText("tail")),
      assistantMessage("tail done"),
      userTextToModelMessage(userText("next")),
    ]);
    expect(store.threads.get("blocking-overflow")?.state).toMatchObject({
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
        userTextToModelMessage(userText("next")),
        storedAssistantOutput("after blocking compaction"),
      ],
    });
  });

  it("preserves the completed-step index when overflow recovery re-enters the loop", async () => {
    const store = new SpyStore();
    const preparedStepIndices: number[] = [];
    const call = toolCallPart("call-before-overflow");
    let calls = 0;
    const agent = agentWithCompaction({
      compaction: tokenCompactionPolicy({ retain: 20, trigger: 50 }),
      host: hostWithThreads(store),
      model: createCallbackModel(() => {
        calls += 1;
        if (calls === 1) {
          return [assistantMessage("old done")];
        }
        if (calls === 2) {
          return [assistantMessage("tail done")];
        }
        if (calls === 3) {
          return [assistantMessage([call])];
        }
        if (calls === 4) {
          throw new Error("context_length_exceeded: too many tokens");
        }
        if (calls === 5) {
          return [assistantMessage("old exchange summarized")];
        }
        return [assistantMessage("DONE")];
      }),
      prepareModelStep: ({ runtimeStepIndex }) => {
        preparedStepIndices.push(runtimeStepIndex);
        return;
      },
      tools: {
        test_tool: tool({
          execute: () => ({}),
          inputSchema: jsonSchema({
            additionalProperties: false,
            properties: {},
            type: "object",
          }),
        }),
      },
    });
    const thread = agent.thread("overflow-after-tool");

    await collect(await thread.send("old"));
    await collect(await thread.send("tail"));
    const events = await collect(await thread.send("next"));

    expect(eventTypes(events)).toContain("turn-end");
    expect(preparedStepIndices.slice(-3)).toEqual([0, 1, 1]);
    expect(calls).toBe(6);
  });
});
