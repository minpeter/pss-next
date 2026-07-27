import { APICallError, type ModelMessage, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  sentUserText,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect } from "./test-support";

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

    const events = await collect(await agent.send("fail"));

    expect(events).toEqual([
      sentUserText("fail"),
      { type: "turn-start" },
      { type: "step-start" },
      {
        error: { category: "unknown", version: 1 },
        message: "model unavailable",
        type: "turn-error",
      },
    ]);
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
    const turnError = events.at(-1);

    expect(turnError).toEqual({
      error: {
        category: "permission",
        code: "account_suspended",
        correlationIds: [
          { source: "cf-ray", value: "ray-456" },
          { source: "x-infron-request-id", value: "request-123" },
        ],
        observedRetryable: false,
        providerType: "provider_account_error",
        retryAfterMs: 3000,
        status: 403,
        version: 1,
      },
      message: "The provider refused this request.",
      type: "turn-error",
    });
    const serialized = JSON.stringify(turnError);
    for (const secret of ["request-secret", "response-secret", "url-secret"]) {
      expect(serialized).not.toContain(secret);
    }
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
