import { GatewayInternalServerError } from "@ai-sdk/gateway";
import { APICallError, customProvider, RetryError } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import type { StreamAgentEvent } from "../thread/protocol/events";
import { generateModelStepResult } from "./model-step";

const epoch = 1_800_000_000_000;
const history = [{ content: "go", role: "user" }] as const;
const signal = new AbortController().signal;
const failure = (statusCode = 429, responseHeaders?: Record<string, string>) =>
  new APICallError({
    message: "private provider text",
    requestBodyValues: { prompt: "private prompt" },
    responseHeaders,
    statusCode,
    url: "https://private-provider.test/key",
  });

function fixture(
  path: "stream" | "generate" | "string",
  failCount = 1,
  error: Error = failure()
) {
  const calls: number[] = [];
  const execute = () => {
    calls.push(Date.now());
    if (calls.length <= failCount) {
      throw error;
    }
    return mockLanguageModelV4Text("done");
  };
  const model =
    path === "stream"
      ? createStreamingMockLanguageModelV4(() => {
          const result = execute();
          return Promise.resolve({
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { id: "text", type: "text-start" },
              { delta: "done", id: "text", type: "text-delta" },
              { id: "text", type: "text-end" },
              {
                finishReason: result.finishReason,
                type: "finish",
                usage: result.usage,
              },
            ]),
          });
        })
      : createMockLanguageModelV4(() => Promise.resolve(execute()));
  if (path === "string") {
    globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
      languageModels: { fixture: model },
    });
  }
  return { calls, model: path === "string" ? ("fixture" as const) : model };
}

const retries = (events: readonly StreamAgentEvent[]) =>
  events.filter((event) => event.type === "model-retry");

// Backoff itself is the behavior under test. Virtual time drives the actual
// provider-call seam, never a second policy or a mocked SDK retry loop.
describe("authoritative model retry lifecycle", () => {
  let originalProvider: typeof globalThis.AI_SDK_DEFAULT_PROVIDER;
  beforeEach(() => {
    originalProvider = globalThis.AI_SDK_DEFAULT_PROVIDER;
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
  });
  afterEach(() => {
    globalThis.AI_SDK_DEFAULT_PROVIDER = originalProvider;
    vi.useRealTimers();
  });

  it.each(["stream", "generate", "string"] as const)(
    "owns the wait and event ordering for %s models",
    async (path) => {
      const { model, calls } = fixture(path);
      const events: StreamAgentEvent[] = [];
      const pending = generateModelStepResult({
        signal,
        history,
        model,
        onStreamEvent: (event) => events.push(event),
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(calls).toEqual([epoch, epoch + 2000]);
      expect(
        events
          .filter((event) => event.type !== "assistant-output-delta")
          .map((event) => [
            event.type,
            "phase" in event ? event.phase : undefined,
          ])
      ).toEqual([
        ["model-attempt", "start"],
        ["model-attempt", "end"],
        ["model-retry", "scheduled"],
        ["model-retry", "started"],
        ["model-attempt", "start"],
        ["model-attempt", "end"],
      ]);
      expect(retries(events)).toEqual([
        {
          attempt: 1,
          attemptId: result.usage.attemptId,
          delayMs: 2000,
          phase: "scheduled",
          remainingRetries: 2,
          retryAt: epoch + 2000,
          type: "model-retry",
        },
        {
          attempt: 1,
          attemptId: result.usage.attemptId,
          phase: "started",
          remainingRetries: 1,
          type: "model-retry",
        },
      ]);
      expect(
        events.filter((event) => event.type === "assistant-output-delta")
      ).toEqual([{ text: "done", type: "assistant-output-delta" }]);
      expect(
        events
          .filter(
            (event) => event.type === "model-attempt" && event.phase === "end"
          )
          .map((event) =>
            "durationMs" in event ? event.durationMs : undefined
          )
      ).toEqual([0, 0]);
      expect(JSON.stringify(retries(events))).not.toContain("private");
    }
  );

  it("arms the reported deadline before notifying scheduling subscribers", async () => {
    const { model, calls } = fixture("generate");
    const events: StreamAgentEvent[] = [];
    const pending = generateModelStepResult({
      history,
      model,
      signal,
      onStreamEvent: (event) => {
        events.push(event);
        if (event.type === "model-retry" && event.phase === "scheduled") {
          vi.advanceTimersByTime(500);
        }
      },
    });
    await vi.runAllTimersAsync();
    await pending;
    expect(calls).toEqual([epoch, epoch + 2000]);
    expect(retries(events)[0]).toMatchObject({ retryAt: epoch + 2000 });
  });

  it("does not schedule on success", async () => {
    const { model, calls } = fixture("generate", 0);
    const events: StreamAgentEvent[] = [];
    await generateModelStepResult({
      signal,
      history,
      model,
      onStreamEvent: (event) => events.push(event),
    });
    expect(calls).toEqual([epoch]);
    expect(retries(events)).toEqual([]);
  });

  it("exhausts exactly two retries with independent exponential delays", async () => {
    const { model, calls } = fixture("stream", 3);
    const events: StreamAgentEvent[] = [];
    const pending = generateModelStepResult({
      signal,
      history,
      model,
      onStreamEvent: (event) => events.push(event),
    }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(RetryError);
    expect(calls).toEqual([epoch, epoch + 2000, epoch + 6000]);
    expect(retries(events)).toMatchObject([
      {
        attempt: 1,
        delayMs: 2000,
        phase: "scheduled",
        remainingRetries: 2,
        retryAt: epoch + 2000,
      },
      { attempt: 1, phase: "started", remainingRetries: 1 },
      {
        attempt: 2,
        delayMs: 4000,
        phase: "scheduled",
        remainingRetries: 1,
        retryAt: epoch + 6000,
      },
      { attempt: 2, phase: "started", remainingRetries: 0 },
      {
        attempt: 3,
        phase: "stopped",
        reason: "exhausted",
        remainingRetries: 0,
      },
    ]);
  });

  it.each([401, 403, 400])(
    "stops a nonretryable %i failure",
    async (status) => {
      const error = failure(status);
      const { model, calls } = fixture("generate", 3, error);
      const events: StreamAgentEvent[] = [];
      await expect(
        generateModelStepResult({
          signal,
          history,
          model,
          onStreamEvent: (event) => events.push(event),
        })
      ).rejects.toBe(error);
      expect(calls).toEqual([epoch]);
      expect(retries(events)).toMatchObject([
        {
          attempt: 1,
          phase: "stopped",
          reason: "non-retryable",
          remainingRetries: 0,
        },
      ]);
    }
  );

  it.each([
    "before",
    "scheduled-callback",
    "during-wait",
    "started-callback",
  ] as const)("cancels %s without another physical call", async (when) => {
    const { model, calls } = fixture("stream");
    const events: StreamAgentEvent[] = [];
    const controller = new AbortController();
    if (when === "before") {
      controller.abort();
    }
    const pending = generateModelStepResult({
      history,
      model,
      signal: controller.signal,
      onStreamEvent: (event) => {
        events.push(event);
        if (
          event.type === "model-retry" &&
          ((when === "scheduled-callback" && event.phase === "scheduled") ||
            (when === "started-callback" && event.phase === "started"))
        ) {
          controller.abort();
        }
      },
    }).catch((error: unknown) => error);
    if (when === "during-wait") {
      await vi.advanceTimersByTimeAsync(1000);
      expect(retries(events)).toMatchObject([{ phase: "scheduled" }]);
      controller.abort();
    }
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(when === "before" ? 0 : 1);
    expect(retries(events).at(-1)).toMatchObject({
      attempt: when === "before" ? 0 : 1,
      phase: "stopped",
      reason: "cancelled",
      remainingRetries: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [{ "retry-after-ms": "125", "retry-after": "9" }, 125],
    [{ "retry-after": "0.5" }, 500],
    [{ "retry-after": new Date(epoch + 3000).toUTCString() }, 3000],
    [{ "retry-after-ms": "bad", "retry-after": "1" }, 1000],
    [{ "retry-after-ms": "-1", "retry-after": "1" }, 2000],
    [{ "retry-after-ms": "60000" }, 2000],
    [{ "retry-after-ms": "0" }, 0],
  ] as const)(
    "uses SDK-compatible header override %j",
    async (headers, delayMs) => {
      const { model, calls } = fixture("generate", 1, failure(429, headers));
      const events: StreamAgentEvent[] = [];
      const pending = generateModelStepResult({
        signal,
        history,
        model,
        onStreamEvent: (event) => events.push(event),
      });
      await vi.runAllTimersAsync();
      await pending;
      expect(calls).toEqual([epoch, epoch + delayMs]);
      expect(retries(events)[0]).toMatchObject({
        delayMs,
        retryAt: epoch + delayMs,
      });
    }
  );

  it.each(["AbortError", "TimeoutError", "ResponseAborted"])(
    "never retries provider %s errors without an aborted signal",
    async (name) => {
      const error = Object.assign(new Error("provider abort"), { name });
      const { model, calls } = fixture("generate", 3, error);
      const events: StreamAgentEvent[] = [];
      await expect(
        generateModelStepResult({
          history,
          model,
          signal,
          onStreamEvent: (event) => events.push(event),
        })
      ).rejects.toBe(error);
      expect(calls).toHaveLength(1);
      expect(retries(events)).toMatchObject([
        { phase: "stopped", reason: "cancelled", remainingRetries: 0 },
      ]);
    }
  );

  it("retries gateway errors using their API-call cause's delay", async () => {
    const error = new GatewayInternalServerError({
      message: "private gateway",
      cause: failure(503, { "retry-after-ms": "75" }),
    });
    const { model, calls } = fixture("generate", 1, error);
    const events: StreamAgentEvent[] = [];
    const pending = generateModelStepResult({
      history,
      model,
      signal,
      onStreamEvent: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await pending;
    expect(calls).toEqual([epoch, epoch + 75]);
    expect(retries(events)[0]).toMatchObject({
      delayMs: 75,
      retryAt: epoch + 75,
    });
  });

  it("honors explicit isRetryable instead of inferring from HTTP status", async () => {
    const error = new APICallError({
      isRetryable: false,
      message: "fixture",
      requestBodyValues: {},
      statusCode: 429,
      url: "https://fixture.test",
    });
    const { model, calls } = fixture("stream", 3, error);
    const events: StreamAgentEvent[] = [];
    const pending = generateModelStepResult({
      history,
      model,
      signal,
      onStreamEvent: (event) => events.push(event),
    }).catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(error);
    expect(calls).toHaveLength(1);
    expect(retries(events)).toMatchObject([
      { phase: "stopped", reason: "non-retryable" },
    ]);
  });

  it("retains failure classification when a retry becomes nonretryable", async () => {
    const error = failure(401);
    let calls = 0;
    const model = createMockLanguageModelV4(() => {
      calls += 1;
      throw calls === 1 ? failure() : error;
    });
    const events: StreamAgentEvent[] = [];
    const pending = generateModelStepResult({
      history,
      model,
      signal,
      onStreamEvent: (event) => events.push(event),
    }).catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      lastError: error,
      reason: "errorNotRetryable",
    });
    expect(calls).toBe(2);
    expect(retries(events).at(-1)).toMatchObject({
      attempt: 2,
      phase: "stopped",
      reason: "non-retryable",
      remainingRetries: 0,
    });
    expect(
      events.filter((event) => event.type === "model-attempt").at(-1)
    ).toMatchObject({ error: { category: "authentication", status: 401 } });
  });

  it("isolates concurrent waits on a shared model", async () => {
    const calls = new Map<string, number>();
    const model = createMockLanguageModelV4(({ prompt }) => {
      const key = JSON.stringify(prompt);
      const count = (calls.get(key) ?? 0) + 1;
      calls.set(key, count);
      if (count === 1) {
        throw failure();
      }
      return Promise.resolve(mockLanguageModelV4Text("done"));
    });
    const first: StreamAgentEvent[] = [];
    const second: StreamAgentEvent[] = [];
    const controller = new AbortController();
    const a = generateModelStepResult({
      history,
      model,
      signal: controller.signal,
      onStreamEvent: (event) => {
        first.push(event);
        if (event.type === "model-retry" && event.phase === "scheduled") {
          controller.abort();
        }
      },
    }).catch((error: unknown) => error);
    const b = generateModelStepResult({
      signal,
      history: [{ content: "other", role: "user" }],
      model,
      onStreamEvent: (event) => second.push(event),
    });
    await vi.runAllTimersAsync();
    expect(await a).toMatchObject({ name: "AbortError" });
    await b;
    expect([...calls.values()]).toEqual([1, 2]);
    expect(retries(first).at(-1)).toMatchObject({
      phase: "stopped",
      reason: "cancelled",
    });
    expect(retries(second).map((event) => event.phase)).toEqual([
      "scheduled",
      "started",
    ]);
    expect(retries(first)[0]?.attemptId).not.toBe(
      retries(second)[0]?.attemptId
    );
  });
});
