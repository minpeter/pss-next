import { jsonSchema, tool } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4GenerateResult,
  type MockLanguageModelV4StreamResult,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import type { StreamAgentEvent } from "../thread/protocol/events";
import { generateModelStepResult } from "./model-step";

type MockStreamPart =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const prompt = [{ content: "go", role: "user" }] as const;
const timestampFixture = new Date("2026-07-23T02:00:00.000Z");
const lookupTool = tool({
  inputSchema: jsonSchema({
    additionalProperties: false,
    properties: { city: { type: "string" } },
    required: ["city"],
    type: "object",
  }),
});
const streamUsageFixture = {
  inputTokens: {
    cacheRead: 3,
    cacheWrite: 1,
    noCache: 7,
    total: 11,
  },
  outputTokens: { reasoning: 5, text: 8, total: 13 },
  raw: { fixture: "stream" },
};
const generateUsageFixture = {
  inputTokens: {
    cacheRead: 1,
    cacheWrite: 0,
    noCache: 20,
    total: 21,
  },
  outputTokens: { reasoning: 3, text: 7, total: 10 },
  raw: { fixture: "generate" },
};

describe("generateModelStepResult stream events", () => {
  it("forwards doStream deltas in order before resolving with committed output", async () => {
    const chunks = [
      { type: "stream-start", warnings: [] },
      {
        id: "response-stream",
        modelId: "response-model",
        timestamp: timestampFixture,
        type: "response-metadata",
      },
      { id: "text-1", type: "text-start" },
      { delta: "hello", id: "text-1", type: "text-delta" },
      { id: "text-1", type: "text-end" },
      { id: "reasoning-1", type: "reasoning-start" },
      { delta: "think", id: "reasoning-1", type: "reasoning-delta" },
      { id: "reasoning-1", type: "reasoning-end" },
      {
        id: "call-stream",
        toolName: "lookup",
        type: "tool-input-start",
      },
      {
        delta: JSON.stringify({ city: "Seoul" }),
        id: "call-stream",
        type: "tool-input-delta",
      },
      { id: "call-stream", type: "tool-input-end" },
      {
        finishReason: { raw: "fixture-stop", unified: "stop" },
        type: "finish",
        usage: streamUsageFixture,
      },
    ] satisfies MockStreamPart[];
    const events: StreamAgentEvent[] = [];
    const model = createStreamingMockLanguageModelV4([
      { stream: convertArrayToReadableStream(chunks) },
    ]);

    const result = await generateModelStepResult({
      history: prompt,
      model,
      onStreamEvent: (event) => {
        events.push(event);
      },
      signal: new AbortController().signal,
      tools: { lookup: lookupTool },
    }).then((resolved) => {
      expect(events).not.toHaveLength(0);
      expect(events).toEqual([
        { text: "hello", type: "assistant-output-delta" },
        { text: "think", type: "assistant-reasoning-delta" },
        {
          toolCallId: "call-stream",
          toolName: "lookup",
          type: "tool-call-input-start",
        },
        {
          inputTextDelta: JSON.stringify({ city: "Seoul" }),
          toolCallId: "call-stream",
          type: "tool-call-input-delta",
        },
        {
          toolCallId: "call-stream",
          type: "tool-call-input-end",
        },
      ]);
      return resolved;
    });

    expect(result.messages).toEqual([
      {
        content: [
          { providerOptions: undefined, text: "hello", type: "text" },
          {
            providerOptions: undefined,
            text: "think",
            type: "reasoning",
          },
        ],
        role: "assistant",
      },
    ]);
    expect(result.usage).toEqual({
      attemptId: expect.any(String),
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      durationMs: expect.any(Number),
      finishReason: "stop",
      inputTokens: 11,
      modelId: "response-model",
      noCacheTokens: 7,
      outputTokens: 13,
      provider: "mock-provider",
      reasoningTokens: 5,
      totalTokens: 24,
      type: "model-usage",
    });
  });

  it("forwards synthesized doGenerate deltas and preserves generateText results", async () => {
    const content = [
      { text: "think first", type: "reasoning" },
      { text: "answer next", type: "text" },
      {
        input: JSON.stringify({ city: "Busan" }),
        toolCallId: "call-1",
        toolName: "lookup",
        type: "tool-call",
      },
    ] satisfies MockLanguageModelV4GenerateResult["content"];
    const model = createMockLanguageModelV4([
      {
        content,
        finishReason: { raw: "fixture-tools", unified: "tool-calls" },
        response: {
          headers: { "x-fixture": "generate" },
          id: "response-generate",
          modelId: "generate-model",
          timestamp: timestampFixture,
        },
        usage: generateUsageFixture,
        warnings: [],
      },
    ]);
    const events: StreamAgentEvent[] = [];

    const result = await generateModelStepResult({
      history: prompt,
      model,
      onStreamEvent: (event) => {
        events.push(event);
      },
      signal: new AbortController().signal,
      tools: { lookup: lookupTool },
    });

    expect(events).toEqual([
      { text: "think first", type: "assistant-reasoning-delta" },
      { text: "answer next", type: "assistant-output-delta" },
      {
        toolCallId: "call-1",
        toolName: "lookup",
        type: "tool-call-input-start",
      },
      {
        inputTextDelta: JSON.stringify({ city: "Busan" }),
        toolCallId: "call-1",
        type: "tool-call-input-delta",
      },
      { toolCallId: "call-1", type: "tool-call-input-end" },
    ]);
    expect(result.messages).toEqual([
      {
        content: [
          {
            providerOptions: undefined,
            text: "think first",
            type: "reasoning",
          },
          {
            providerOptions: undefined,
            text: "answer next",
            type: "text",
          },
          {
            input: { city: "Busan" },
            providerExecuted: undefined,
            providerOptions: undefined,
            toolCallId: "call-1",
            toolName: "lookup",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
    ]);
    expect(result.usage).toEqual({
      attemptId: expect.any(String),
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      durationMs: expect.any(Number),
      finishReason: "tool-calls",
      inputTokens: 21,
      modelId: "generate-model",
      noCacheTokens: 20,
      outputTokens: 10,
      provider: "mock-provider",
      reasoningTokens: 3,
      totalTokens: 31,
      type: "model-usage",
    });
  });

  it("rejects a gracefully closed aborted stream after forwarding prior deltas", async () => {
    const abortController = new AbortController();
    const model = createStreamingMockLanguageModelV4(
      async ({ abortSignal }) => ({
        stream: new ReadableStream<MockStreamPart>({
          start(controller) {
            abortSignal?.addEventListener(
              "abort",
              () => controller.error(abortSignal.reason),
              { once: true }
            );
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ id: "text-1", type: "text-start" });
            controller.enqueue({
              delta: "before abort",
              id: "text-1",
              type: "text-delta",
            });
          },
        }),
      })
    );
    const events: StreamAgentEvent[] = [];
    let producedResult = false;
    let thrown: unknown;

    try {
      await generateModelStepResult({
        history: prompt,
        model,
        onStreamEvent: (event) => {
          events.push(event);
          abortController.abort(
            new DOMException("fixture provider abort", "AbortError")
          );
        },
        signal: abortController.signal,
      });
      producedResult = true;
    } catch (error) {
      thrown = error;
    }

    expect(producedResult).toBe(false);
    expect(thrown).toMatchObject({
      message: "The operation was aborted.",
      name: "AbortError",
    });
    expect(events).toEqual([
      { text: "before abort", type: "assistant-output-delta" },
    ]);
  });

  it("rejects stream errors without leaking an unhandled finalization rejection", async () => {
    const fixtureError = new Error("fixture stream failure");
    const model = createStreamingMockLanguageModelV4(() =>
      Promise.reject(fixtureError)
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await expect(
        generateModelStepResult({
          history: prompt,
          model,
          signal: new AbortController().signal,
        })
      ).rejects.toBe(fixtureError);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("preserves result behavior when onStreamEvent is omitted", async () => {
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("done", generateUsageFixture),
    ]);

    const result = await generateModelStepResult({
      history: prompt,
      model,
      signal: new AbortController().signal,
    });

    expect(result.messages).toEqual([
      {
        content: [{ providerOptions: undefined, text: "done", type: "text" }],
        role: "assistant",
      },
    ]);
    expect(result.usage).toEqual({
      attemptId: expect.any(String),
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      durationMs: expect.any(Number),
      finishReason: "stop",
      inputTokens: 21,
      modelId: "mock-model-id",
      noCacheTokens: 20,
      outputTokens: 10,
      provider: "mock-provider",
      reasoningTokens: 3,
      totalTokens: 31,
      type: "model-usage",
    });
  });
});
