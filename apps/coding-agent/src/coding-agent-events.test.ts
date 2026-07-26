import type { AgentEvent } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { createCodingAgent } from "./coding-agent";
import {
  collectEvents,
  createFailingModel,
  createStreamingModel,
} from "./coding-agent-events.test-support";
import { createCodingAgentExtensionHost } from "./extensions/host";

describe("coding-agent extension events", () => {
  it("observes a typed turn error with run context exactly once", async () => {
    const observed: {
      event: AgentEvent;
      operation: string;
      runId: string | undefined;
      stream: boolean;
      threadKey: string;
    }[] = [];
    const extensionHost = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.on("turn-error", (event, context) => {
            observed.push({
              event,
              operation: context.operation,
              runId: context.runId,
              stream: context.stream,
              threadKey: context.threadKey,
            });
          });
        },
        id: "error-observer",
      },
    ]);
    const agent = await createCodingAgent({
      extensionHost,
      model: createFailingModel(),
    });

    try {
      const turn = await agent.send("fail");
      const events = await collectEvents(turn.events());

      expect(events.at(-1)?.type).toBe("turn-error");
      expect(observed).toEqual([
        {
          event: events.at(-1),
          operation: "send",
          runId: turn.runId,
          stream: false,
          threadKey: "default",
        },
      ]);
    } finally {
      await agent.dispose();
      await extensionHost.dispose();
    }
  });

  it("observes stream events only through an explicit stream event name", async () => {
    const deltas: string[] = [];
    const turnErrors: AgentEvent[] = [];
    const extensionHost = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.on("assistant-output-delta", (event, context) => {
            expect(context.stream).toBe(true);
            deltas.push(event.text);
          });
          pss.on("turn-error", (event) => {
            turnErrors.push(event);
          });
        },
        id: "stream-observer",
      },
    ]);
    const agent = await createCodingAgent({
      extensionHost,
      model: createStreamingModel(),
    });

    try {
      await collectEvents((await agent.send("hello")).events());

      expect(deltas).toEqual(["hello"]);
      expect(turnErrors).toEqual([]);
    } finally {
      await agent.dispose();
      await extensionHost.dispose();
    }
  });

  it("runs matching observers in extension and registration order", async () => {
    const order: string[] = [];
    const extensionHost = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.on("assistant-output-delta", async () => {
            order.push("first:one:start");
            await Promise.resolve();
            order.push("first:one:end");
          });
          pss.on("assistant-output-delta", () => {
            order.push("first:two");
          });
        },
        id: "first",
      },
      {
        default(pss) {
          pss.on("assistant-output-delta", () => {
            order.push("second:one");
          });
        },
        id: "second",
      },
    ]);
    const agent = await createCodingAgent({
      extensionHost,
      model: createStreamingModel(),
    });

    try {
      await collectEvents((await agent.send("hello")).events());

      expect(order).toEqual([
        "first:one:start",
        "first:one:end",
        "first:two",
        "second:one",
      ]);
    } finally {
      await agent.dispose();
      await extensionHost.dispose();
    }
  });

  it("isolates event context from JavaScript observer mutation", async () => {
    const consumed: AgentEvent[] = [];
    let secondStreamValue: boolean | undefined;
    const extensionHost = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.on("turn-error", (_event, context) => {
            (context as { stream: boolean }).stream = true;
          });
        },
        id: "mutating-observer",
      },
      {
        default(pss) {
          pss.on("turn-error", (_event, context) => {
            secondStreamValue = context.stream;
          });
        },
        id: "following-observer",
      },
    ]);
    const agent = await createCodingAgent({
      extensionHost,
      model: createFailingModel(),
    });

    try {
      await expect(
        (async () => {
          for await (const event of (await agent.send("fail")).events()) {
            consumed.push(event);
          }
        })()
      ).rejects.toThrow(
        'Coding agent extension "mutating-observer" failed during event'
      );
      expect(secondStreamValue).toBe(false);
      expect(consumed.at(-1)?.type).toBe("turn-error");
    } finally {
      await agent.dispose();
      await extensionHost.dispose();
    }
  });

  it("attributes observer failures without replacing the original event", async () => {
    const consumed: AgentEvent[] = [];
    const extensionHost = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.on("turn-error", () => {
            throw new Error("observer failed");
          });
        },
        id: "failing-observer",
      },
    ]);
    const agent = await createCodingAgent({
      extensionHost,
      model: createFailingModel(),
    });

    try {
      await expect(
        (async () => {
          for await (const event of (await agent.send("fail")).events()) {
            consumed.push(event);
          }
        })()
      ).rejects.toThrow(
        'Coding agent extension "failing-observer" failed during event'
      );
      expect(consumed.at(-1)?.type).toBe("turn-error");
    } finally {
      await agent.dispose();
      await extensionHost.dispose();
    }
  });
});
