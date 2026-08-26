import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  committedEvents,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { collect } from "./test-support";
import {
  collectThreadEvents,
  hostWithOneUsageAppendFailure,
} from "./thread-events-test-support";

describe("AgentThread durable event replay", () => {
  it("streams and replays billed usage before a model-step hook failure", async () => {
    const host = createInMemoryHost();
    const durableTypesAtHook: string[] = [];
    const agent = await createAgent({
      hooks: {
        transformModelStep: async () => {
          const threadEvents = host.store.threadEvents;
          if (!threadEvents) {
            throw new Error("expected durable thread event log");
          }
          for await (const record of threadEvents.read(
            "durable-usage-hook-error"
          )) {
            durableTypesAtHook.push(record.event.type);
          }
          throw new Error("model-step hook failed");
        },
      },
      host,
      model: createCallbackModel(() => [assistantMessage("UNREACHABLE")]),
    });
    const thread = agent.thread("durable-usage-hook-error");

    const live = await collect(await thread.send("hello"));
    const replayed = await collectThreadEvents(thread.events());
    const liveUsage = live.find((event) => event.type === "model-usage");
    const replayedUsage = replayed.find(
      ({ event }) => event.type === "model-usage"
    )?.event;

    expect(
      live
        .filter((event) => event.type !== "context-usage")
        .map((event) => event.type)
    ).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "assistant-output-delta",
      "model-usage",
      "turn-error",
    ]);
    expect(replayed.map(({ event }) => event.type)).toEqual(
      committedEvents(live).map((event) => event.type)
    );
    expect(liveUsage).toMatchObject({
      attemptId: expect.any(String),
      type: "model-usage",
    });
    expect(replayedUsage).toEqual(liveUsage);
    expect(durableTypesAtHook).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "model-usage",
    ]);
  });

  it("restores a transient usage flush and persists it once during recovery", async () => {
    const base = createInMemoryHost();
    let failedUsageAppend = false;
    let modelStepHookCalls = 0;
    const host = hostWithOneUsageAppendFailure(base, () => {
      failedUsageAppend = true;
    });
    const agent = await createAgent({
      hooks: {
        transformModelStep: () => {
          modelStepHookCalls += 1;
          return { action: "continue" };
        },
      },
      host,
      model: createCallbackModel(() => [assistantMessage("UNREACHABLE")]),
    });
    const thread = agent.thread("durable-usage-transient-flush");

    const live = await collect(await thread.send("hello"));
    const replayed = await collectThreadEvents(thread.events());
    const liveUsage = live.filter((event) => event.type === "model-usage");
    const replayedUsage = replayed
      .map(({ event }) => event)
      .filter((event) => event.type === "model-usage");

    expect(failedUsageAppend).toBe(true);
    expect(modelStepHookCalls).toBe(0);
    expect(
      live
        .filter((event) => event.type !== "context-usage")
        .map((event) => event.type)
    ).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "assistant-output-delta",
      "model-usage",
      "turn-error",
    ]);
    expect(replayed.map(({ event }) => event.type)).toEqual(
      committedEvents(live).map((event) => event.type)
    );
    expect(liveUsage).toHaveLength(1);
    expect(replayedUsage).toEqual(liveUsage);
  });
});
