import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, createAgent } from "../../agent/core/agent";
import type { AgentHost, HostStoreTransaction } from "../../execution";
import { createInMemoryHost, MemoryThreadStore } from "../../platform/memory";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  committedEvents,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { ThreadEventReplayUnsupportedError } from "../runtime/thread-event-replay";
import { collect } from "./test-support";

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
    expect(replayed.at(-1)?.event).toEqual({
      error: { category: "unknown", version: 1 },
      message: "model unavailable",
      type: "turn-error",
    });
  });

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

    expect(live.map((event) => event.type)).toEqual([
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
    expect(live.map((event) => event.type)).toEqual([
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

  it("keeps provider secrets out of live rollback failure events", async () => {
    const providerError = new APICallError({
      isRetryable: false,
      message: "Bearer secret-token request-secret response-secret url-secret",
      requestBodyValues: { apiKey: "request-secret" },
      responseBody: '{"secret":"response-secret"}',
      statusCode: 403,
      url: "https://provider.example/v1/chat?token=url-secret",
    });
    const base = createInMemoryHost();
    const agent = new Agent({
      host: hostWithTurnErrorAppendFailure(base),
      model: createCallbackModel(() => Promise.reject(providerError)),
    });

    const live = await collect(
      await agent.thread("safe-rollback-failure").send("hello")
    );
    const turnError = live.at(-1);
    const serialized = JSON.stringify(turnError);

    expect(turnError).toEqual({
      error: {
        category: "permission",
        observedRetryable: false,
        status: 403,
        version: 1,
      },
      message:
        "The provider refused this request. History rollback persistence failed.",
      type: "turn-error",
    });
    for (const secret of [
      "secret-token",
      "request-secret",
      "response-secret",
      "url-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
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

async function collectThreadEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function hostWithOneUsageAppendFailure(
  base: AgentHost,
  onFailure: () => void
): AgentHost {
  let shouldFail = true;
  return {
    ...base,
    store: {
      checkpoints: base.store.checkpoints,
      events: base.store.events,
      inputs: base.store.inputs,
      notifications: base.store.notifications,
      threadEvents: base.store.threadEvents,
      threads: base.store.threads,
      transaction: (fn) =>
        base.store.transaction(async (tx) =>
          fn(transactionWithOneUsageAppendFailure(tx))
        ),
      turns: base.store.turns,
    },
  };

  function transactionWithOneUsageAppendFailure(
    tx: HostStoreTransaction
  ): HostStoreTransaction {
    const threadEvents = tx.threadEvents;
    if (!threadEvents) {
      return tx;
    }
    return {
      ...tx,
      threadEvents: {
        append: async (threadKey, event) => {
          if (shouldFail && event.type === "model-usage") {
            shouldFail = false;
            onFailure();
            throw new Error("transient usage event append failure");
          }
          return await threadEvents.append(threadKey, event);
        },
        read: (threadKey, options) => threadEvents.read(threadKey, options),
      },
    };
  }
}

function hostWithTurnErrorAppendFailure(base: AgentHost): AgentHost {
  return {
    ...base,
    store: {
      checkpoints: base.store.checkpoints,
      events: base.store.events,
      inputs: base.store.inputs,
      notifications: base.store.notifications,
      threadEvents: base.store.threadEvents,
      threads: base.store.threads,
      transaction: (fn) =>
        base.store.transaction(async (tx) =>
          fn(transactionWithTurnErrorAppendFailure(tx))
        ),
      turns: base.store.turns,
    },
  };

  function transactionWithTurnErrorAppendFailure(
    tx: HostStoreTransaction
  ): HostStoreTransaction {
    const threadEvents = tx.threadEvents;
    if (!threadEvents) {
      return tx;
    }
    return {
      ...tx,
      threadEvents: {
        append: async (threadKey, event) => {
          if (event.type === "turn-error") {
            throw new Error("turn error append failure");
          }
          return await threadEvents.append(threadKey, event);
        },
        read: (threadKey, options) => threadEvents.read(threadKey, options),
      },
    };
  }
}
