import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost, MemoryThreadStore } from "../../platform/memory";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { ThreadEventReplayUnsupportedError } from "../runtime/thread-event-replay";
import { collect } from "./test-support";
import { collectThreadEvents } from "./thread-events-test-support";

describe("AgentThread durable event replay", () => {
  it("replays committed thread events with cursor pagination", async () => {
    const host = createInMemoryHost();
    const agent = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    });
    const thread = agent.thread("durable-events");

    await collect(await thread.send("hello"));

    const firstPage = await collectThreadEvents(thread.events({ limit: 3 }));
    expect(firstPage.map((record) => record.event.type)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
    ]);
    expect(firstPage.map((record) => record.cursor.offset)).toEqual([1, 2, 3]);
    expect(firstPage.map((record) => record.threadKey)).toEqual([
      "durable-events",
      "durable-events",
      "durable-events",
    ]);

    const lastRecord = firstPage.at(-1);
    if (!lastRecord) {
      throw new Error("expected first replay page");
    }

    const secondPage = await collectThreadEvents(
      thread.events({ after: lastRecord.cursor })
    );
    expect(secondPage.map((record) => record.event.type)).toEqual([
      "model-usage",
      "assistant-output",
      "step-end",
      "turn-end",
    ]);
    expect(secondPage.map((record) => record.cursor.offset)).toEqual([
      4, 5, 6, 7,
    ]);
  });

  it("replays failed turns with their durable turn-error event", async () => {
    const host = createInMemoryHost();
    const agent = new Agent({
      host,
      model: createCallbackModel(() =>
        Promise.reject(new Error("model unavailable"))
      ),
    });
    const thread = agent.thread("durable-events-error");

    await collect(await thread.send("fail"));

    const replayed = await collectThreadEvents(thread.events());
    expect(replayed.map((record) => record.event.type)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "turn-error",
    ]);
    const turnError = replayed.at(-1)?.event;
    expect(turnError).toMatchObject({
      error: { category: "unknown", version: 1 },
      type: "turn-error",
    });
    expect(JSON.stringify(turnError)).not.toContain("model unavailable");
  });

  it("throws a typed error when replay is unsupported by the host", () => {
    const base = hostWithThreads(new MemoryThreadStore());
    const agent = new Agent({
      host: {
        ...base,
        store: {
          ...base.store,
          threadEvents: undefined,
          transaction: (fn) =>
            base.store.transaction(async (tx) =>
              fn({
                ...tx,
                threadEvents: undefined,
              })
            ),
        },
      },
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    });

    expect(() => agent.thread("no-replay").events()).toThrow(
      ThreadEventReplayUnsupportedError
    );
  });
});
