import { APICallError, type LanguageModel } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4StreamResult,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import type { ModelAttempt, StreamAgentEvent } from "../thread/protocol/events";
import { createModelAttemptTracker } from "./model-attempt";
import { generateModelStepResult } from "./model-step";

type MockStreamPart =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const prompt = [{ content: "go", role: "user" }] as const;

const textChunks = (text: string) =>
  [
    { type: "stream-start", warnings: [] },
    { id: "text-1", type: "text-start" },
    { delta: text, id: "text-1", type: "text-delta" },
    { id: "text-1", type: "text-end" },
    {
      finishReason: { raw: "stop", unified: "stop" },
      type: "finish",
      usage: {
        inputTokens: {
          cacheRead: undefined,
          cacheWrite: undefined,
          noCache: undefined,
          total: 5,
        },
        outputTokens: {
          reasoning: undefined,
          text: undefined,
          total: 2,
        },
      },
    },
  ] satisfies MockStreamPart[];

const attemptEvents = (events: readonly StreamAgentEvent[]): ModelAttempt[] =>
  events.filter(
    (event): event is ModelAttempt => event.type === "model-attempt"
  );

describe("model-attempt stream events", () => {
  it("emits one start and one end attempt event for a single successful call", async () => {
    const events: StreamAgentEvent[] = [];
    const model = createStreamingMockLanguageModelV4([
      { stream: convertArrayToReadableStream(textChunks("hello")) },
    ]);

    const result = await generateModelStepResult({
      history: prompt,
      model,
      onStreamEvent: (event) => {
        events.push(event);
      },
      signal: new AbortController().signal,
    });

    const attempts = attemptEvents(events);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      attemptId: result.usage.attemptId,
      phase: "start",
      type: "model-attempt",
    });
    expect(attempts[1]).toMatchObject({
      attempt: 1,
      attemptId: result.usage.attemptId,
      outcome: "succeeded",
      phase: "end",
      type: "model-attempt",
    });
  });

  it("emits a second attempt when the provider retries a 429", async () => {
    const events: StreamAgentEvent[] = [];
    let calls = 0;
    const model = createStreamingMockLanguageModelV4(() => {
      calls += 1;
      if (calls === 1) {
        throw new APICallError({
          message: "rate limited",
          requestBodyValues: {},
          responseHeaders: { "retry-after-ms": "0" },
          statusCode: 429,
          url: "https://provider.test/v1/chat",
        });
      }
      return Promise.resolve({
        stream: convertArrayToReadableStream(textChunks("recovered")),
      });
    });

    const result = await generateModelStepResult({
      history: prompt,
      model,
      onStreamEvent: (event) => {
        events.push(event);
      },
      signal: new AbortController().signal,
    });

    expect(calls).toBe(2);
    const attempts = attemptEvents(events);
    const starts = attempts.filter((event) => event.phase === "start");
    expect(starts.map((event) => event.attempt)).toEqual([1, 2]);
    expect(starts).toEqual([
      expect.objectContaining({
        modelId: "mock-model-id",
        provider: "mock-provider",
      }),
      expect.objectContaining({
        modelId: "mock-model-id",
        provider: "mock-provider",
      }),
    ]);
    expect(new Set(attempts.map((event) => event.attemptId))).toEqual(
      new Set([result.usage.attemptId])
    );

    const failedEnd = attempts.find(
      (event) => event.phase === "end" && event.outcome === "failed"
    );
    expect(failedEnd).toMatchObject({
      attempt: 1,
      error: { category: "rate-limit", status: 429 },
      outcome: "failed",
      phase: "end",
    });

    const succeededEnd = attempts.find(
      (event) => event.phase === "end" && event.outcome === "succeeded"
    );
    expect(succeededEnd).toMatchObject({
      attempt: 2,
      durationMs: expect.any(Number),
      outcome: "succeeded",
    });
  });

  it("emits and classifies every non-streaming provider retry", async () => {
    const events: StreamAgentEvent[] = [];
    let calls = 0;
    const model = createMockLanguageModelV4(() => {
      calls += 1;
      if (calls === 1) {
        throw new APICallError({
          message: "rate limited",
          requestBodyValues: {},
          responseHeaders: { "retry-after-ms": "0" },
          statusCode: 429,
          url: "https://provider.test/v1/chat",
        });
      }
      return Promise.resolve(mockLanguageModelV4Text("recovered"));
    });

    const result = await generateModelStepResult({
      history: prompt,
      model,
      onStreamEvent: (event) => {
        events.push(event);
      },
      signal: new AbortController().signal,
    });

    expect(calls).toBe(2);
    const attempts = attemptEvents(events);
    const starts = attempts.filter((event) => event.phase === "start");
    expect(starts.map((event) => event.attempt)).toEqual([1, 2]);
    expect(starts).toEqual([
      expect.objectContaining({
        modelId: "mock-model-id",
        provider: "mock-provider",
      }),
      expect.objectContaining({
        modelId: "mock-model-id",
        provider: "mock-provider",
      }),
    ]);
    expect(new Set(attempts.map((event) => event.attemptId))).toEqual(
      new Set([result.usage.attemptId])
    );
    expect(attempts).toEqual([
      expect.objectContaining({ attempt: 1, phase: "start" }),
      expect.objectContaining({
        attempt: 1,
        error: expect.objectContaining({
          category: "rate-limit",
          status: 429,
        }),
        outcome: "failed",
        phase: "end",
      }),
      expect.objectContaining({ attempt: 2, phase: "start" }),
      expect.objectContaining({
        attempt: 2,
        outcome: "succeeded",
        phase: "end",
      }),
    ]);
  });

  it("measures only the physical call with an injected clock", () => {
    let now = 100;
    const tracker = createModelAttemptTracker({
      attemptId: "attempt-clock",
      now: () => now,
    });

    tracker.begin();
    now = 112;
    expect(tracker.succeed()).toMatchObject({ durationMs: 12 });
    now = 1112;
    tracker.begin();
    now = 1116;
    expect(tracker.fail(new Error("fixture"))).toMatchObject({ durationMs: 4 });
  });

  it("closes an in-band streaming error as a failed attempt", async () => {
    const fixtureError = new APICallError({
      message: "stream rate limited",
      requestBodyValues: {},
      statusCode: 429,
      url: "https://provider.test/v1/chat",
    });
    const events: StreamAgentEvent[] = [];
    const model = createStreamingMockLanguageModelV4([
      {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { error: fixtureError, type: "error" },
          {
            finishReason: { raw: "error", unified: "error" },
            type: "finish",
            usage: {
              inputTokens: {
                cacheRead: undefined,
                cacheWrite: undefined,
                noCache: undefined,
                total: 1,
              },
              outputTokens: {
                reasoning: undefined,
                text: undefined,
                total: 0,
              },
            },
          },
        ] satisfies MockStreamPart[]),
      },
    ]);

    await generateModelStepResult({
      history: prompt,
      model,
      onStreamEvent: (event) => events.push(event),
      signal: new AbortController().signal,
    });

    expect(attemptEvents(events)).toEqual([
      expect.objectContaining({ attempt: 1, phase: "start" }),
      expect.objectContaining({
        attempt: 1,
        error: expect.objectContaining({
          category: "rate-limit",
          status: 429,
        }),
        outcome: "failed",
        phase: "end",
      }),
    ]);
  });

  it("closes a stream without a finish part as a failed attempt", async () => {
    const events: StreamAgentEvent[] = [];
    const model = createStreamingMockLanguageModelV4([
      {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { id: "text-1", type: "text-start" },
          { delta: "partial", id: "text-1", type: "text-delta" },
          { id: "text-1", type: "text-end" },
        ] satisfies MockStreamPart[]),
      },
    ]);

    await generateModelStepResult({
      history: prompt,
      model,
      onStreamEvent: (event) => events.push(event),
      signal: new AbortController().signal,
    });

    expect(attemptEvents(events)).toEqual([
      expect.objectContaining({ attempt: 1, phase: "start" }),
      expect.objectContaining({
        attempt: 1,
        outcome: "failed",
        phase: "end",
      }),
    ]);
  });

  it("isolates concurrent steps sharing one model and leaves it unchanged", async () => {
    const firstEvents: StreamAgentEvent[] = [];
    const secondEvents: StreamAgentEvent[] = [];
    let calls = 0;
    let releaseCalls: () => void = () => undefined;
    const callsStarted = new Promise<void>((resolve) => {
      releaseCalls = resolve;
    });
    const model = createMockLanguageModelV4(async () => {
      calls += 1;
      if (calls === 2) {
        releaseCalls();
      }
      await callsStarted;
      return mockLanguageModelV4Text("done");
    });
    const before = {
      doGenerate: Object.getOwnPropertyDescriptor(model, "doGenerate"),
      doStream: Object.getOwnPropertyDescriptor(model, "doStream"),
    };

    await Promise.all([
      generateModelStepResult({
        history: prompt,
        model,
        onStreamEvent: (event) => firstEvents.push(event),
        signal: new AbortController().signal,
      }),
      generateModelStepResult({
        history: prompt,
        model,
        onStreamEvent: (event) => secondEvents.push(event),
        signal: new AbortController().signal,
      }),
    ]);

    expect(calls).toBe(2);
    for (const events of [firstEvents, secondEvents]) {
      expect(attemptEvents(events)).toEqual([
        expect.objectContaining({ attempt: 1, phase: "start" }),
        expect.objectContaining({
          attempt: 1,
          outcome: "succeeded",
          phase: "end",
        }),
      ]);
    }
    expect({
      doGenerate: Object.getOwnPropertyDescriptor(model, "doGenerate"),
      doStream: Object.getOwnPropertyDescriptor(model, "doStream"),
    }).toEqual(before);
  });

  it("preserves the original receiver for models with private fields", async () => {
    class PrivateFieldModel {
      readonly modelId = "private-model";
      readonly provider = "private-provider";
      readonly specificationVersion = "v4" as const;
      readonly supportedUrls = {};
      readonly #text = "private result";

      doGenerate() {
        return Promise.resolve(mockLanguageModelV4Text(this.#text));
      }

      doStream() {
        return Promise.resolve({
          stream: convertArrayToReadableStream(textChunks(this.#text)),
        });
      }
    }

    const streamingModel = new PrivateFieldModel();
    const generatedModel = new PrivateFieldModel();
    Object.defineProperty(generatedModel, "doStream", {
      configurable: true,
      value: undefined,
    });

    for (const model of [streamingModel, generatedModel]) {
      const result = await generateModelStepResult({
        history: prompt,
        model: model as LanguageModel,
        signal: new AbortController().signal,
      });
      expect(result.messages).toMatchObject([
        {
          content: [expect.objectContaining({ text: "private result" })],
          role: "assistant",
        },
      ]);
    }
  });

  it("classifies the failed attempt when every retry is exhausted", async () => {
    const events: StreamAgentEvent[] = [];
    const model = createStreamingMockLanguageModelV4(() => {
      throw new APICallError({
        message: "rate limited",
        requestBodyValues: {},
        responseHeaders: { "retry-after-ms": "0" },
        statusCode: 429,
        url: "https://provider.test/v1/chat",
      });
    });

    await expect(
      generateModelStepResult({
        history: prompt,
        model,
        onStreamEvent: (event) => {
          events.push(event);
        },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow();

    const attempts = attemptEvents(events);
    const starts = attempts.filter((event) => event.phase === "start");
    expect(starts.map((event) => event.attempt)).toEqual([1, 2, 3]);

    expect(attempts.at(-1)).toMatchObject({
      attempt: 3,
      error: { category: "rate-limit", status: 429 },
      outcome: "failed",
      phase: "end",
    });
  });
});
