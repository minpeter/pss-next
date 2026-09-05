import { APICallError, customProvider, jsonSchema, tool } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4StreamResult,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import type { ModelAttempt, StreamAgentEvent } from "../thread/protocol/events";
import { normalizeTurnError } from "../thread/runtime/turn-error-metadata";
import { createModelAttemptTracker } from "./model-attempt";
import { generateModelStepResult } from "./model-step";
import { createModelStepStream } from "./model-step-stream";

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

const expectBalancedAttempts = (events: readonly StreamAgentEvent[]) => {
  const attempts = attemptEvents(events);
  const starts = attempts.filter((event) => event.phase === "start");
  const ends = attempts.filter((event) => event.phase === "end");
  expect(
    ends.map(({ attempt, attemptId }) => ({ attempt, attemptId }))
  ).toEqual(starts.map(({ attempt, attemptId }) => ({ attempt, attemptId })));
};

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
    expectBalancedAttempts(events);
  });

  it("balances a successful non-streaming call", async () => {
    const events: StreamAgentEvent[] = [];
    await generateModelStepResult({
      history: prompt,
      model: createMockLanguageModelV4([mockLanguageModelV4Text("done")]),
      onStreamEvent: (event) => events.push(event),
      signal: new AbortController().signal,
    });

    expectBalancedAttempts(events);
    expect(attemptEvents(events)).toHaveLength(2);
  });

  it("balances a successful string-model call resolved by the default provider", async () => {
    const events: StreamAgentEvent[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve(mockLanguageModelV4Text("string success")),
      doStream: () =>
        Promise.resolve({
          stream: convertArrayToReadableStream(textChunks("string success")),
        }),
    });
    const originalProvider = globalThis.AI_SDK_DEFAULT_PROVIDER;
    globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
      languageModels: { "fixture-string-model": model },
    });

    try {
      await generateModelStepResult({
        history: prompt,
        model: "fixture-string-model",
        onStreamEvent: (event) => events.push(event),
        signal: new AbortController().signal,
      });
    } finally {
      globalThis.AI_SDK_DEFAULT_PROVIDER = originalProvider;
    }

    expect(attemptEvents(events)).toEqual([
      expect.objectContaining({ attempt: 1, phase: "start" }),
      expect.objectContaining({
        attempt: 1,
        outcome: "succeeded",
        phase: "end",
      }),
    ]);
    expectBalancedAttempts(events);
  });

  it("classifies and balances a retried string-model call", async () => {
    const events: StreamAgentEvent[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: () => {
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
        return Promise.resolve(mockLanguageModelV4Text("string recovered"));
      },
      doStream: () =>
        Promise.resolve({
          stream: convertArrayToReadableStream(textChunks("string recovered")),
        }),
    });
    const originalProvider = globalThis.AI_SDK_DEFAULT_PROVIDER;
    globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
      languageModels: { "fixture-string-model": model },
    });

    try {
      await generateModelStepResult({
        history: prompt,
        model: "fixture-string-model",
        onStreamEvent: (event) => events.push(event),
        signal: new AbortController().signal,
      });
    } finally {
      globalThis.AI_SDK_DEFAULT_PROVIDER = originalProvider;
    }

    expect(calls).toBe(2);
    expectBalancedAttempts(events);
    expect(attemptEvents(events)).toEqual([
      expect.objectContaining({ attempt: 1, phase: "start" }),
      expect.objectContaining({
        attempt: 1,
        error: expect.objectContaining({
          category: "rate-limit",
          status: 429,
          version: 1,
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
      modelId: "mock-model-id",
      outcome: "failed",
      phase: "end",
      provider: "mock-provider",
    });

    const succeededEnd = attempts.find(
      (event) => event.phase === "end" && event.outcome === "succeeded"
    );
    expect(succeededEnd).toMatchObject({
      attempt: 2,
      durationMs: expect.any(Number),
      outcome: "succeeded",
    });
    expectBalancedAttempts(events);
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
        modelId: "mock-model-id",
        outcome: "failed",
        phase: "end",
        provider: "mock-provider",
      }),
      expect.objectContaining({ attempt: 2, phase: "start" }),
      expect.objectContaining({
        attempt: 2,
        outcome: "succeeded",
        phase: "end",
      }),
    ]);
    expectBalancedAttempts(events);
  });

  it("balances an abort at provider-call start", async () => {
    const abortController = new AbortController();
    const events: StreamAgentEvent[] = [];
    const model = createStreamingMockLanguageModelV4(({ abortSignal }) => {
      abortSignal?.throwIfAborted();
      return Promise.resolve({
        stream: convertArrayToReadableStream(textChunks("unreachable")),
      });
    });

    await expect(
      generateModelStepResult({
        history: prompt,
        model,
        onStreamEvent: (event) => {
          events.push(event);
          if (event.type === "model-attempt" && event.phase === "start") {
            abortController.abort(new DOMException("fixture", "AbortError"));
          }
        },
        signal: abortController.signal,
      })
    ).rejects.toThrow();

    expectBalancedAttempts(events);
    expect(attemptEvents(events)).toHaveLength(2);
  });

  it("matches turn-error transport classification and retains failed identity", () => {
    const providerError = new APICallError({
      cause: Object.assign(new Error("transport failure"), {
        code: "ENOTFOUND",
      }),
      isRetryable: true,
      message: "provider request failed",
      requestBodyValues: {},
      url: "https://provider.test/v1/chat",
    });
    const tracker = createModelAttemptTracker({ attemptId: "attempt-network" });
    tracker.begin({ modelId: "model-network", provider: "provider-network" });

    const failed = tracker.fail(providerError);
    const turnErrorCategory = normalizeTurnError(providerError).error?.category;

    expect(turnErrorCategory).toBe("network");
    expect(failed).toMatchObject({
      error: { category: turnErrorCategory, code: "ENOTFOUND" },
      modelId: "model-network",
      outcome: "failed",
      phase: "end",
      provider: "provider-network",
    });
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

  it("closes a displaced attempt before beginning the next one", () => {
    const tracker = createModelAttemptTracker({
      attemptId: "attempt-displaced",
      now: () => 100,
    });
    const events = [
      ...tracker.begin(),
      ...tracker.begin(),
      tracker.fail(new Error("second failed")),
    ].filter((event): event is ModelAttempt => event !== undefined);

    expect(events).toEqual([
      expect.objectContaining({ attempt: 1, phase: "start" }),
      expect.objectContaining({
        attempt: 1,
        outcome: "failed",
        phase: "end",
      }),
      expect.objectContaining({ attempt: 2, phase: "start" }),
      expect.objectContaining({
        attempt: 2,
        outcome: "failed",
        phase: "end",
      }),
    ]);
  });

  it("ends a successful streaming attempt before gated tool execution", async () => {
    let now = 100;
    let releaseTool: () => void = () => undefined;
    let markToolStarted: () => void = () => undefined;
    const toolRelease = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const events: ModelAttempt[] = [];
    const tracker = createModelAttemptTracker({
      attemptId: "attempt-tool-clock",
      now: () => now,
    });
    const model = createStreamingMockLanguageModelV4(async () => ({
      stream: new ReadableStream<MockStreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            id: "call-1",
            toolName: "gated",
            type: "tool-input-start",
          });
          controller.enqueue({
            delta: "{}",
            id: "call-1",
            type: "tool-input-delta",
          });
          controller.enqueue({ id: "call-1", type: "tool-input-end" });
          controller.enqueue({
            input: "{}",
            toolCallId: "call-1",
            toolName: "gated",
            type: "tool-call",
          });
          now = 125;
          controller.enqueue({
            finishReason: { raw: "tool-calls", unified: "tool-calls" },
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
                total: 1,
              },
            },
          });
          controller.close();
        },
      }),
    }));
    const source = createModelStepStream({
      messages: [...prompt],
      model,
      onAttemptEnd: (result) => {
        const event =
          result.outcome === "succeeded"
            ? tracker.succeed(result.origin)
            : tracker.fail(result.error);
        if (event) {
          events.push(event);
        }
      },
      onAttemptStart: (origin) => events.push(...tracker.begin(origin)),
      tools: {
        gated: tool({
          execute: async () => {
            now = 1125;
            markToolStarted();
            await toolRelease;
            return "done";
          },
          inputSchema: jsonSchema({
            additionalProperties: false,
            properties: {},
            type: "object",
          }),
        }),
      },
    });

    const consuming = (async () => {
      for await (const _part of source.parts) {
        // Consume the stream so the SDK reaches tool execution.
      }
      await source.finalize();
    })();
    await Promise.race([
      toolStarted,
      consuming.then(() => {
        throw new Error("stream finished before the gated tool started");
      }),
    ]);

    const eventsAtToolStart = [...events];
    releaseTool();
    await consuming;

    expect(eventsAtToolStart).toEqual([
      expect.objectContaining({ phase: "start" }),
      expect.objectContaining({
        durationMs: 25,
        outcome: "succeeded",
        phase: "end",
      }),
    ]);
    expect(events).toHaveLength(2);
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
    expectBalancedAttempts(events);
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
    expectBalancedAttempts(events);
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
      expectBalancedAttempts(events);
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

  it.each(["direct", "prepared"] as const)(
    "preserves private-backed model accessor receivers on the %s path",
    async (path) => {
      class PrivateFieldModel {
        readonly modelId = "private-model";
        readonly specificationVersion = "v4" as const;
        readonly #provider = "private-provider";
        readonly #text = "private result";
        readonly #urls = {};

        get provider() {
          return this.#provider;
        }

        get supportedUrls() {
          return this.#urls;
        }

        doGenerate() {
          return Promise.resolve(mockLanguageModelV4Text(this.#text));
        }

        doStream() {
          return Promise.resolve({
            stream: convertArrayToReadableStream(textChunks(this.#text)),
          });
        }
      }

      const selectedModel = new PrivateFieldModel();
      const result = await generateModelStepResult({
        history: prompt,
        model:
          path === "direct" ? selectedModel : createMockLanguageModelV4([]),
        ...(path === "prepared"
          ? {
              prepareModelStep: () => ({ model: selectedModel }),
              threadKey: "private-accessor-thread",
            }
          : {}),
        signal: new AbortController().signal,
      });

      expect(result.messages).toMatchObject([
        {
          content: [expect.objectContaining({ text: "private result" })],
          role: "assistant",
        },
      ]);
      expect(result.usage).toMatchObject({
        modelId: "private-model",
        provider: "private-provider",
      });
    }
  );

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

    expectBalancedAttempts(events);
    expect(attempts.at(-1)).toMatchObject({
      attempt: 3,
      error: { category: "rate-limit", status: 429 },
      outcome: "failed",
      phase: "end",
    });
  });
});
