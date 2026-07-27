import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import type { AgentHooks } from "../../agent/core/hooks";
import {
  assistantMessage,
  createCallbackModel,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import { userTextToModelMessage } from "../protocol/mapping";

describe("thread.send intercept", () => {
  it("queues transformed user-input into model history", async () => {
    const seenHistory: ModelMessage[][] = [];
    const hooks: AgentHooks = {
      acceptInput: (event) => {
        if (
          event.type !== "user-input" ||
          !("text" in event) ||
          typeof event.text !== "string"
        ) {
          return;
        }
        return {
          action: "transform" as const,
          value: { ...event, text: `TAG:${event.text}` },
        };
      },
    };
    const agent = await createAgent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
      hooks,
    });

    await collect(await agent.send("hello"));

    expect(seenHistory[0]).toEqual([
      userTextToModelMessage(userText("TAG:hello")),
    ]);
  });

  it("skips turn-start when send input is handled", async () => {
    const hooks: AgentHooks = {
      acceptInput: () => ({ action: "handled" as const }),
    };
    const agent = await createAgent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
      hooks,
    });

    const events = await collect(await agent.send("hello"));

    expect(events.map((event) => event.type)).toEqual([]);
  });
});
