import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import type { AgentHooks } from "../../agent/core/hooks";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  sentUserText,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import { userTextToModelMessage } from "../protocol/mapping";

describe("thread hook intercept integration", () => {
  it("routes by meta.source=send in acceptInput", async () => {
    const hooks: AgentHooks = {
      acceptInput: (event) => {
        if (event.type !== "user-input" || event.meta?.source !== "send") {
          return;
        }
        if (!("text" in event) || typeof event.text !== "string") {
          return;
        }
        return {
          action: "transform",
          value: {
            ...event,
            text: `<user>\n${event.text}\n</user>`,
          },
        };
      },
    };
    const agent = await createAgent({
      hooks,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    const events = await collect(await agent.send("hello"));

    expect(events[0]).toEqual(sentUserText("<user>\nhello\n</user>"));
  });

  it("passes history and thread identity to input and turn hooks", async () => {
    const seen: string[] = [];
    const hooks: AgentHooks = {
      acceptInput: (event, { history, threadKey }) => {
        seen.push(`${event.type}:${history.length}:${threadKey}`);
        return { action: "continue" };
      },
      beforeTurnStart: (event, { history, threadKey }) => {
        seen.push(`${event.type}:${history.length}:${threadKey}`);
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

    expect(seen).toEqual(["user-input:0:default", "turn-start:1:default"]);
  });

  it("surfaces turn hook failures as turn-error", async () => {
    const agent = await createAgent({
      hooks: {
        beforeTurnStart: () => {
          throw new Error("turn-start hook failed");
        },
      },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    const events = await collect(
      await agent.thread("terminal-hook").send("first")
    );

    expect(eventTypes(events)).toContain("turn-error");
  });

  it("matches emitted text to model history after transform", async () => {
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
          action: "transform",
          value: { ...event, text: `X:${event.text}` },
        };
      },
    };
    const agent = await createAgent({
      hooks,
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });

    await collect(await agent.send("hello"));

    expect(seenHistory[0]).toEqual([
      userTextToModelMessage(userText("X:hello")),
    ]);
  });
});
