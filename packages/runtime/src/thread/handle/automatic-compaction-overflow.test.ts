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
  agentWithAutoCompaction,
  nextMacrotask,
  storedAssistantOutput,
  tenTokensPerMessage,
  tokenCompactionPolicy,
} from "./automatic-compaction.test-support";
import { collect, SpyStore } from "./test-support";

describe("Agent thread automatic compaction overflow recovery", () => {
  it("counts instructions when adapting a custom compaction estimator to the gate", async () => {
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: {
        estimateTokens: tenTokensPerMessage,
        maxInputTokens: 15,
        retainTokens: 5,
        triggerTokens: 15,
      },
      instructions: "system instructions",
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("unexpected")];
      }),
    });

    const events = await collect(
      await agent.thread("custom-estimator-instructions").send("too much")
    );

    expect(calls).toBe(0);
    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "turn-error",
    ]);
    expect(events.at(-1)).toMatchObject({
      message: expect.stringContaining("context gate"),
      type: "turn-error",
    });
  });

  it("compacts old messages when large instructions push the gate over budget", async () => {
    const store = new SpyStore();
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: {
        maxInputTokens: 2000,
        retainTokens: 700,
        triggerTokens: 1500,
      },
      host: hostWithThreads(store),
      instructions: "i".repeat(2400),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage(`DONE ${calls}`)];
      }),
    });
    const thread = agent.thread("instructions-overflow");

    await collect(await thread.send("x".repeat(500)));
    await collect(await thread.send("y".repeat(500)));
    const events = await collect(await thread.send("z".repeat(4400)));

    expect(events.at(-1)).toEqual({ type: "turn-end" });
    const storedCompactions = () =>
      (
        store.threads.get("instructions-overflow")?.state as
          | { compactions?: unknown[] }
          | undefined
      )?.compactions;
    for (let tick = 0; tick < 20; tick += 1) {
      await nextMacrotask();
      if (storedCompactions()) {
        break;
      }
    }
    expect(storedCompactions()).toMatchObject([
      { endSeqExclusive: 4, schemaVersion: 1, startSeq: 0 },
    ]);
  });

  it("rejects before provider calls when the context gate overflows with error", async () => {
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: {
        contextGate: {
          estimateTokens: () => 2,
          maxInputTokens: 1,
          onOverflow: "error",
        },
        estimateTokens: tenTokensPerMessage,
        maxInputTokens: 10_000,
        retainTokens: 20,
        triggerTokens: 50,
      },
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("unexpected")];
      }),
    });

    const events = await collect(
      await agent.thread("gate-error").send("too much")
    );

    expect(calls).toBe(0);
    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "turn-error",
    ]);
    expect(events.at(-1)).toMatchObject({
      message: expect.stringContaining("context gate"),
      type: "turn-error",
    });
  });

  it("compacts before retrying a context gate overflow", async () => {
    const store = new SpyStore();
    const providerHistories: ModelMessage[][] = [];
    let calls = 0;
    const agent = agentWithAutoCompaction({
      autoCompaction: {
        contextGate: {
          estimateTokens: ({ messages }) => (messages.length > 4 ? 100 : 1),
          maxInputTokens: 50,
          onOverflow: "compact",
        },
        estimateTokens: tenTokensPerMessage,
        maxInputTokens: 10_000,
        retainTokens: 20,
        triggerTokens: 50,
      },
      host: hostWithThreads(store),
      model: createCallbackModel(({ history }) => {
        calls += 1;
        providerHistories.push([...history]);
        if (calls === 1) {
          return [assistantMessage("old done")];
        }
        if (calls === 2) {
          return [assistantMessage("tail done")];
        }
        if (calls === 3) {
          return [assistantMessage("old exchange summarized")];
        }
        return [assistantMessage("after gated compaction")];
      }),
    });
    const thread = agent.thread("gate-compact");

    await collect(await thread.send("old"));
    await collect(await thread.send("tail"));
    const events = await collect(await thread.send("next"));

    expect(eventTypes(events)).toContain("turn-end");
    expect(eventTypes(events).filter((type) => type === "model-usage")).toEqual(
      ["model-usage"]
    );
    expect(events).toContainEqual({
      text: "after gated compaction",
      type: "assistant-output",
    });
    expect(calls).toBe(4);
    expect(providerHistories).not.toContainEqual([
      userTextToModelMessage(userText("old")),
      assistantMessage("old done"),
      userTextToModelMessage(userText("tail")),
      assistantMessage("tail done"),
      userTextToModelMessage(userText("next")),
    ]);
    expect(providerHistories.at(-1)).toEqual([
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

  it("blocks for compaction and retries once when the model overflows context", async () => {
    const store = new SpyStore();
    const retryHistory: ModelMessage[][] = [];
    let calls = 0;
    const preparedStepIndices: number[] = [];
    const agent = agentWithAutoCompaction({
      autoCompaction: tokenCompactionPolicy({ retain: 20, trigger: 50 }),
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
    const agent = agentWithAutoCompaction({
      autoCompaction: tokenCompactionPolicy({ retain: 20, trigger: 50 }),
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
