import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Empty,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  committedEvents,
  createScriptedModelOptions,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../../thread/protocol/events";
import { userTextToModelMessage } from "../../thread/protocol/mapping";
import { ModelMessageHistory } from "../../thread/state/history";
import { runAgentLoop } from "./run";

const seedUserTurn = (history: ModelMessageHistory) => {
  const message = userTextToModelMessage(userText("start"));
  history.appendModelMessage(message);
  return message;
};

describe("runAgentLoop", () => {
  it("continues after assistant messages request any tool", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    const userMessage = seedUserTurn(history);
    const toolCall = toolCallPart("call-tool-1");
    const model = createScriptedModelOptions([
      [
        assistantMessage([
          { type: "text", text: "I should keep going." },
          toolCall,
        ]),
        toolResultFor(toolCall),
      ],
      [assistantMessage("DONE")],
    ]);

    await expect(
      runAgentLoop({
        emit: (event) => {
          events.push(event);
        },
        history,
        model,
      })
    ).resolves.toBe("completed");

    expect(committedEvents(events)).toEqual([
      { type: "step-start" },
      expect.objectContaining({ type: "model-usage" }),
      { type: "assistant-output", text: "I should keep going." },
      {
        type: "tool-call",
        input: {},
        toolCallId: "call-tool-1",
        toolName: "test_tool",
      },
      {
        type: "tool-result",
        output: { type: "json", value: {} },
        toolCallId: "call-tool-1",
        toolName: "test_tool",
      },
      { type: "step-end" },
      { type: "step-start" },
      expect.objectContaining({ type: "model-usage" }),
      { type: "assistant-output", text: "DONE" },
      { type: "step-end" },
    ]);
    expect(history.modelSnapshot()).toMatchObject([
      userMessage,
      {
        content: [
          { text: "I should keep going.", type: "text" },
          {
            input: {},
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      toolResultFor(toolCall),
      { content: [{ text: "DONE", type: "text" }], role: "assistant" },
    ]);
  });

  it("owns a zero-based runtime step index across generated tool steps", async () => {
    const history = new ModelMessageHistory();
    seedUserTurn(history);
    const toolCall = toolCallPart("call-tool-index");
    const indices: number[] = [];
    const model = {
      ...createScriptedModelOptions([
        [assistantMessage([toolCall]), toolResultFor(toolCall)],
        [assistantMessage("DONE")],
      ]),
      prepareModelStep: ({
        runtimeStepIndex,
      }: {
        runtimeStepIndex: number;
      }) => {
        indices.push(runtimeStepIndex);
        return;
      },
    };

    await expect(
      runAgentLoop({
        emit: () => undefined,
        history,
        model,
        threadKey: "indexed-thread",
      })
    ).resolves.toBe("completed");

    expect(indices).toEqual([0, 1]);
  });

  it("returns aborted when the LLM rejects after the signal is aborted", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    const userMessage = seedUserTurn(history);
    const controller = new AbortController();
    const model = createMockLanguageModelV4(() => {
      controller.abort();
      throw new Error("model request aborted");
    });

    await expect(
      runAgentLoop({
        emit: (event) => {
          events.push(event);
        },
        history,
        model: { model },
        signal: controller.signal,
      })
    ).resolves.toBe("aborted");

    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(history.modelSnapshot()).toEqual([userMessage]);
  });

  it("returns aborted when the LLM resolves empty output after the signal is aborted", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    const userMessage = seedUserTurn(history);
    const controller = new AbortController();
    const model = createMockLanguageModelV4(() => {
      controller.abort();
      return Promise.resolve(mockLanguageModelV4Empty());
    });

    await expect(
      runAgentLoop({
        emit: (event) => {
          events.push(event);
        },
        history,
        model: { model },
        signal: controller.signal,
      })
    ).resolves.toBe("aborted");

    // abort wins over a resolve that races it: no usage or committed output is emitted once signal.aborted (unified streaming path, plan streaming-support criterion 3).
    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(history.modelSnapshot()).toEqual([userMessage]);
  });
});
