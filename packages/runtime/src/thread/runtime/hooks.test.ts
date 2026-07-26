import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import type { AgentHooks } from "../../agent/core/hooks";
import {
  assistantMessage,
  createCallbackModel,
  steerRuntimeInput,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import { userTextToModelMessage } from "../protocol/mapping";

describe("Agent thread runtime input hooks", () => {
  it("drains hook steering at turn-start and after model-step", async () => {
    const seenHistory: ModelMessage[][] = [];
    let step = 0;
    let thread: ReturnType<Awaited<ReturnType<typeof createAgent>>["thread"]>;
    const hooks: AgentHooks = {
      beforeTurnStart: async () => {
        await thread.steer("turn start steer");
        return { action: "continue" };
      },
      transformModelStep: async () => {
        if (step === 1) {
          await thread.steer("model step steer");
        }
        return { action: "continue" };
      },
    };
    const agent = await createAgent({
      hooks,
      model: createCallbackModel(({ history }) => {
        step += 1;
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(step === 1 ? "This could be final." : "DONE"),
        ]);
      }),
    });
    thread = agent.thread("hook-steer");

    const events = await collect(await thread.send("original"));

    expect(events).toContainEqual(
      steerRuntimeInput("turn start steer", "turn-start")
    );
    expect(events).toContainEqual(
      steerRuntimeInput("model step steer", "step-end")
    );
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("turn start steer")),
      ],
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("turn start steer")),
        assistantMessage("This could be final."),
        userTextToModelMessage(userText("model step steer")),
      ],
    ]);
  });
});
