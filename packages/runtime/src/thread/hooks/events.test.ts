import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import type { AgentHooks } from "../../agent/core/hooks";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  committedEvents,
  createCallbackModel,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import { isStreamAgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";

describe("Agent thread hooks", () => {
  it("calls hooks for queued turn phases with current history", async () => {
    const hookCalls: string[] = [];
    const hooks: AgentHooks = {
      acceptInput: (event, { history }) => {
        hookCalls.push(`${event.type}:${history.length}`);
        return { action: "continue" };
      },
      beforeTurnStart: (event, { history }) => {
        hookCalls.push(`${event.type}:${history.length}`);
        return { action: "continue" };
      },
      transformModelContext: (_event, { history }) => {
        hookCalls.push(`model-context:${history.length}`);
        return { action: "continue" };
      },
      transformModelStep: (_event, { history }) => {
        hookCalls.push(`model-step:${history.length}`);
        return { action: "continue" };
      },
    };
    const agent = await createAgent({
      hooks,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    const events = await collect(await agent.send("hello"));

    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "model-usage",
      "assistant-output",
      "step-end",
      "turn-end",
    ]);
    expect(hookCalls).toEqual([
      "user-input:0",
      "turn-start:1",
      "model-context:1",
      "model-step:1",
    ]);
  });

  it("lets hooks branch on their invocation payloads", async () => {
    const hookPayloads: string[] = [];
    const hooks: AgentHooks = {
      acceptInput: (event) => {
        hookPayloads.push(event.type);
        return { action: "continue" };
      },
      beforeTurnStart: (event) => {
        hookPayloads.push(event.type);
        return { action: "continue" };
      },
      transformModelContext: (event) => {
        hookPayloads.push(`context:${event.messages.length}`);
        return { action: "continue" };
      },
      transformModelStep: (event) => {
        hookPayloads.push(`step:${event.output[0]?.role}`);
        return { action: "continue" };
      },
    };
    const agent = await createAgent({
      hooks,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(await agent.send("hello"));

    expect(hookPayloads).toEqual([
      "user-input",
      "turn-start",
      "context:1",
      "step:assistant",
    ]);
  });

  it("commits and persists transformed model output after live deltas", async () => {
    const host = createInMemoryHost();
    const agent = await createAgent({
      hooks: {
        transformModelStep: () => ({
          action: "transform",
          value: [assistantMessage("sanitized")],
        }),
      },
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("raw-protocol")])
      ),
    });

    const events = await collect(await agent.send("hello"));
    const streamJson = JSON.stringify(events.filter(isStreamAgentEvent));
    const committedJson = JSON.stringify(committedEvents(events));
    const storedJson = JSON.stringify(await host.store.threads.load("default"));

    expect(streamJson).toContain("raw-protocol");
    expect(committedJson).toContain("sanitized");
    expect(committedJson).not.toContain("raw-protocol");
    expect(storedJson).toContain("sanitized");
    expect(storedJson).not.toContain("raw-protocol");
  });

  it("rolls back the active turn when a model-step hook fails", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = await createAgent({
      hooks: {
        transformModelStep: () => {
          throw new Error("model-step hook failed");
        },
      },
      model: createCallbackModel(({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage(`DONE ${calls}`)]);
      }),
    });

    const firstEvents = await collect(
      await agent.thread("model-step-hook-error").send("first")
    );
    const secondEvents = await collect(
      await agent.thread("model-step-hook-error").send("second")
    );

    expect(eventTypes(firstEvents)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "model-usage",
      "turn-error",
    ]);
    expect(eventTypes(secondEvents)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "model-usage",
      "turn-error",
    ]);
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("second")),
    ]);
  });
});
