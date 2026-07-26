import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import type { AgentHooks } from "../../agent/core/hooks";
import {
  assistantMessage,
  committedEvents,
  createCallbackModel,
  eventTypes,
  sentUserText,
  steerRuntimeInput,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";

describe("Agent thread runtime input windows", () => {
  it("orders hooks around runtime input windows", async () => {
    const hookCalls: string[] = [];
    const trace: string[] = [];
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const hooks: AgentHooks = {
      acceptInput: (event, { history }) => {
        hookCalls.push(`${event.type}:${history.length}`);
        trace.push(`hook:${event.type}`);
        return { action: "continue" as const };
      },
      beforeTurnStart: (event, { history }) => {
        hookCalls.push(`${event.type}:${history.length}`);
        trace.push(`hook:${event.type}`);
        return { action: "continue" as const };
      },
      transformModelContext: (event, { history }) => {
        hookCalls.push(
          `model-context:${history.length}:${event.messages.length}`
        );
        trace.push("hook:model-context");
        return { action: "continue" as const };
      },
      transformModelStep: (event, { history }) => {
        hookCalls.push(`model-step:${history.length}:${event.output.length}`);
        trace.push("hook:model-step");
        return { action: "continue" as const };
      },
    };
    const agent = await createAgent({
      hooks,
      model: createCallbackModel(({ history }) => {
        trace.push(`llm:${calls}`);
        seenHistory.push([...history]);
        calls += 1;
        return Promise.resolve([
          assistantMessage(["SEED", "FIRST", "DONE"][calls - 1] ?? "DONE"),
        ]);
      }),
    });
    const thread = agent.thread("hook-runtime-ordering");

    await collect(await thread.send("prior"));

    hookCalls.length = 0;
    trace.length = 0;
    seenHistory.length = 0;

    const run = await thread.send("original");
    const events: AgentEvent[] = [];
    let addedTurnStart = false;
    let addedStepStart = false;
    let addedStepEnd = false;

    for await (const event of run.events()) {
      events.push(event);
      trace.push(`event:${event.type}`);

      if (event.type === "turn-start" && !addedTurnStart) {
        addedTurnStart = true;
        await thread.steer("turn runtime");
      }

      if (event.type === "step-start" && !addedStepStart) {
        addedStepStart = true;
        await thread.steer("step runtime");
      }

      if (event.type === "step-end" && !addedStepEnd) {
        addedStepEnd = true;
        await thread.steer("step-end runtime");
      }
    }

    const priorHistory = [
      userTextToModelMessage(userText("prior")),
      assistantMessage("SEED"),
    ];
    const firstStepHistory = [
      ...priorHistory,
      userTextToModelMessage(userText("original")),
      userTextToModelMessage(userText("turn runtime")),
      userTextToModelMessage(userText("step runtime")),
    ];
    const secondStepHistory = [
      ...firstStepHistory,
      assistantMessage("FIRST"),
      userTextToModelMessage(userText("step-end runtime")),
    ];
    const finalHistory = [...secondStepHistory, assistantMessage("DONE")];

    expect(hookCalls).toEqual([
      "user-input:2",
      "turn-start:3",
      "runtime-input:3",
      "runtime-input:4",
      "model-context:5:5",
      "model-step:5:1",
      "runtime-input:6",
      "model-context:7:7",
      "model-step:7:1",
    ]);
    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "runtime-input",
      "step-start",
      "runtime-input",
      "model-usage",
      "assistant-output",
      "step-end",
      "runtime-input",
      "step-start",
      "model-usage",
      "assistant-output",
      "step-end",
      "turn-end",
    ]);
    expect(events).toContainEqual(
      steerRuntimeInput("turn runtime", "turn-start")
    );
    expect(events).toContainEqual(
      steerRuntimeInput("step runtime", "step-start")
    );
    expect(events).toContainEqual(
      steerRuntimeInput("step-end runtime", "step-end")
    );
    expect(seenHistory).toEqual([firstStepHistory, secondStepHistory]);
    expect(trace).toEqual([
      "hook:user-input",
      "event:user-input",
      "hook:turn-start",
      "event:turn-start",
      "hook:runtime-input",
      "event:runtime-input",
      "event:step-start",
      "hook:runtime-input",
      "event:runtime-input",
      "hook:model-context",
      "llm:1",
      "event:assistant-output-delta",
      "event:model-usage",
      "hook:model-step",
      "event:assistant-output",
      "event:step-end",
      "hook:runtime-input",
      "event:runtime-input",
      "event:step-start",
      "hook:model-context",
      "llm:2",
      "event:assistant-output-delta",
      "event:model-usage",
      "hook:model-step",
      "event:assistant-output",
      "event:step-end",
      "event:turn-end",
    ]);
    expect(finalHistory).toEqual([
      ...priorHistory,
      userTextToModelMessage(userText("original")),
      userTextToModelMessage(userText("turn runtime")),
      userTextToModelMessage(userText("step runtime")),
      assistantMessage("FIRST"),
      userTextToModelMessage(userText("step-end runtime")),
      assistantMessage("DONE"),
    ]);
  });

  it("active thread.steer at turn-start and step-start is visible before the first LLM snapshot", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await createAgent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });
    const thread = agent.thread("early-steer");
    const run = await thread.send("original");
    const events: AgentEvent[] = [];
    let addedTurnStart = false;
    let addedStepStart = false;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "turn-start" && !addedTurnStart) {
        addedTurnStart = true;
        await thread.steer("turn runtime");
      }
      if (event.type === "step-start" && !addedStepStart) {
        addedStepStart = true;
        await thread.steer("step runtime");
      }
    }

    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("turn runtime")),
        userTextToModelMessage(userText("step runtime")),
      ],
    ]);
    expect(committedEvents(events)).toEqual([
      sentUserText("original"),
      { type: "turn-start" },
      steerRuntimeInput("turn runtime", "turn-start"),
      { type: "step-start" },
      steerRuntimeInput("step runtime", "step-start"),
      expect.objectContaining({ type: "model-usage" }),
      { type: "assistant-output", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });
});
