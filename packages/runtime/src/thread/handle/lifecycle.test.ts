import { APICallError, type ModelMessage, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  sentUserText,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import type { StoredThread } from "../store/types";
import { collect, SpyStore } from "./test-support";

class FailingLoadStore extends SpyStore {
  failLoads = 0;

  override load(key: string): Promise<StoredThread | null> {
    if (this.failLoads > 0) {
      this.failLoads -= 1;
      return Promise.reject(new Error("store offline"));
    }
    return super.load(key);
  }
}

describe("Agent thread lifecycle", () => {
  it("idle thread.steer starts a new turn after turn-end", async () => {
    let calls = 0;
    const agent = new Agent({
      model: createCallbackModel(() => {
        calls += 1;
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });
    const thread = agent.thread("idle-steer-after-turn-end");
    const run = await thread.send("initial");

    await collect(run);

    await collect(await thread.steer("late"));
    expect(calls).toBe(2);
  });

  it("idle thread.steer starts a new turn after model turn-error", async () => {
    let calls = 0;
    const agent = new Agent({
      model: createCallbackModel(() => {
        calls += 1;
        return Promise.reject(new Error("model unavailable"));
      }),
    });
    const thread = agent.thread("idle-steer-after-turn-error");
    const run = await thread.send("initial");

    expect(eventTypes(await collect(run))).toContain("turn-error");

    expect(eventTypes(await collect(await thread.steer("late")))).toContain(
      "turn-error"
    );
    expect(calls).toBe(2);
  });

  it("idle thread.steer starts a new turn after interrupt turn-abort", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const thread = new Agent({
      model: createCallbackModel(async () => {
        llmStarted.resolve();
        await llmGate.promise;
        return [assistantMessage("DONE")];
      }),
    }).thread("interrupt-terminal");
    const run = await thread.send("initial");
    const events = collect(run);

    await llmStarted.promise;
    thread.interrupt();
    llmGate.resolve();

    expect(eventTypes(await events)).toContain("turn-abort");
    expect(eventTypes(await collect(await thread.steer("late")))).toContain(
      "turn-end"
    );
  });

  it("rejects runtime input after events return", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const run = await agent.send("initial");
    const iterator = run.events()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: sentUserText("initial"),
    });
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(eventTypes(await collect(await agent.send("late")))).toContain(
      "turn-end"
    );
  });

  it("emits turn-error in the run when the LLM fails", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.reject(new Error("model unavailable"))
      ),
    });

    const events = (await collect(await agent.send("fail"))).filter(
      (event) =>
        event.type !== "context-usage" && event.type !== "model-attempt"
    );

    expect(events).toMatchObject([
      sentUserText("fail"),
      { type: "turn-start" },
      { type: "step-start" },
      {
        error: { category: "unknown", version: 1 },
        type: "turn-error",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("model unavailable");
  });

  it("restores context usage before exposing a failed turn", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.reject(new Error("model unavailable"))
      ),
    });

    const events = await collect(await agent.send("fail"));
    const errorIndex = events.findIndex((event) => event.type === "turn-error");
    const restored = events[errorIndex - 1];

    expect(restored?.type).toBe("context-usage");
    if (restored?.type === "context-usage") {
      expect(restored.currentRequest.total.tokens).toBe(0);
    }
  });

  it("emits whitelisted structured metadata for API call failures", async () => {
    const providerError = new APICallError({
      data: {
        error: {
          code: "account_suspended",
          message: "Account access denied",
          type: "provider_account_error",
        },
      },
      isRetryable: false,
      message:
        "Account access denied request-secret response-secret url-secret",
      requestBodyValues: { apiKey: "request-secret" },
      responseBody: '{"secret":"response-secret"}',
      responseHeaders: {
        authorization: "Bearer response-secret",
        "cf-ray": "ray-456",
        "retry-after": "3",
        "x-infron-request-id": "request-123",
      },
      statusCode: 403,
      url: "https://provider.example/v1/chat/completions?token=url-secret",
    });
    const retryError = new RetryError({
      errors: [new Error("first attempt failed"), providerError],
      message: "Failed after 2 attempts",
      reason: "maxRetriesExceeded",
    });
    const agent = new Agent({
      model: createCallbackModel(() => Promise.reject(retryError)),
    });

    const events = await collect(await agent.send("fail safely"));
    const turnError = events
      .filter(
        (event) =>
          event.type !== "context-usage" && event.type !== "model-attempt"
      )
      .at(-1);

    expect(turnError).toMatchObject({
      error: {
        category: "permission",
        observedRetryable: false,
        retryAfterMs: 3000,
        status: 403,
        version: 1,
      },
      type: "turn-error",
    });
    expect(turnError).not.toHaveProperty("error.code");
    expect(turnError).not.toHaveProperty("error.correlationIds");
    expect(turnError).not.toHaveProperty("error.providerType");
    const serialized = JSON.stringify(turnError);
    for (const secret of ["request-secret", "response-secret", "url-secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("retries the initial load after a failed start", async () => {
    const store = new FailingLoadStore();
    store.failLoads = 1;
    const thread = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    }).thread("retry-load");

    await expect(thread.send("first")).rejects.toThrow("store offline");

    // The load failure is not sticky: the next send reloads and succeeds.
    const events = await collect(await thread.send("second"));
    expect(eventTypes(events)).toContain("turn-end");
  });

  it("deletes a thread whose load keeps failing", async () => {
    const store = new FailingLoadStore();
    store.failLoads = Number.POSITIVE_INFINITY;
    const thread = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    }).thread("delete-after-failed-load");

    await expect(thread.send("first")).rejects.toThrow("store offline");

    // Shutdown must not replay the load failure; delete completes.
    await expect(thread.delete()).resolves.toBeUndefined();
    await expect(thread.send("after")).rejects.toThrow("Thread killed");
  });

  it("interrupts the active run without aborting queued input", async () => {
    const firstLlmCall = createDeferred();
    const firstLlmStarted = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const thread = new Agent({
      model: createCallbackModel(async ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        if (calls === 1) {
          firstLlmStarted.resolve();
          await firstLlmCall.promise;
        }
        return [assistantMessage("DONE")];
      }),
    }).thread("interrupt");

    const firstRun = await thread.send("first");
    const secondRun = await thread.send("second");
    const firstEvents = collect(firstRun);
    const secondEvents = collect(secondRun);

    await firstLlmStarted.promise;
    thread.interrupt();
    firstLlmCall.resolve();

    expect(eventTypes(await firstEvents)).toContain("turn-abort");
    expect(eventTypes(await secondEvents)).toContain("turn-end");
    expect(calls).toBe(2);
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("first")),
      userTextToModelMessage(userText("second")),
    ]);
  });
});
