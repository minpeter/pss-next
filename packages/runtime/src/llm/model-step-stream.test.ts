import { jsonSchema, tool } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4GenerateResult,
  type MockLanguageModelV4StreamResult,
} from "../testing/mock-language-model-v4-test-utils";
import {
  createModelStepStream,
  type ModelStepStreamPart,
} from "./model-step-stream";

type MockStreamPart =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const prompt = [{ content: "go", role: "user" }] as const;
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
  raw: { fixture: true },
};
const expectedStreamUsage = {
  inputTokenDetails: {
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    noCacheTokens: 7,
  },
  inputTokens: 11,
  outputTokenDetails: { reasoningTokens: 5, textTokens: 8 },
  outputTokens: 13,
  totalTokens: 24,
};
const streamTimestampFixture = new Date("2026-07-23T00:00:00.000Z");
const streamResponseMessagesFixture = [
  {
    content: [
      { providerOptions: undefined, text: "hello", type: "text" },
      { providerOptions: undefined, text: "think", type: "reasoning" },
    ],
    role: "assistant",
  },
] as const;

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
const expectedGenerateUsage = {
  inputTokenDetails: {
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    noCacheTokens: 20,
  },
  inputTokens: 21,
  outputTokenDetails: { reasoningTokens: 3, textTokens: 7 },
  outputTokens: 10,
  totalTokens: 31,
};
const generateTimestampFixture = new Date("2026-07-23T01:00:00.000Z");
const generateContentFixture = [
  { text: "text one", type: "text" },
  { text: "reason one", type: "reasoning" },
  {
    input: JSON.stringify({ city: "Seoul" }),
    toolCallId: "call-1",
    toolName: "lookup",
    type: "tool-call",
  },
  { text: "reason two", type: "reasoning" },
  { text: "text two", type: "text" },
  {
    input: JSON.stringify({ city: "Busan" }),
    toolCallId: "call-2",
    toolName: "lookup",
    type: "tool-call",
  },
] satisfies MockLanguageModelV4GenerateResult["content"];
const generateResponseMessagesFixture = [
  {
    content: [
      { providerOptions: undefined, text: "text one", type: "text" },
      {
        providerOptions: undefined,
        text: "reason one",
        type: "reasoning",
      },
      {
        input: { city: "Seoul" },
        providerExecuted: undefined,
        providerOptions: undefined,
        toolCallId: "call-1",
        toolName: "lookup",
        type: "tool-call",
      },
      {
        providerOptions: undefined,
        text: "reason two",
        type: "reasoning",
      },
      { providerOptions: undefined, text: "text two", type: "text" },
      {
        input: { city: "Busan" },
        providerExecuted: undefined,
        providerOptions: undefined,
        toolCallId: "call-2",
        toolName: "lookup",
        type: "tool-call",
      },
    ],
    role: "assistant",
  },
] as const;

describe("createModelStepStream", () => {
  it("yields a doStream model's scripted parts and finalizes with SDK parity fields", async () => {
    const chunks = [
      { type: "stream-start", warnings: [] },
      {
        id: "response-stream",
        modelId: "response-model",
        timestamp: streamTimestampFixture,
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
    const model = createStreamingMockLanguageModelV4([
      { stream: convertArrayToReadableStream(chunks) },
    ]);
    const source = createModelStepStream({ messages: [...prompt], model });

    const parts = await collectParts(source.parts);

    expect(selectScriptedParts(parts)).toEqual([
      { id: "text-1", text: "hello", type: "text-delta" },
      {
        id: "reasoning-1",
        text: "think",
        type: "reasoning-delta",
      },
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
    ]);
    expect(parts.map((part) => part.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "finish-step",
      "finish",
    ]);

    const finalized = await source.finalize();
    expect(finalized.responseMessages).toEqual(streamResponseMessagesFixture);
    expect(finalized.usage).toEqual(expectedStreamUsage);
    expect(finalized.finalStep).toMatchObject({
      content: [
        { providerMetadata: undefined, text: "hello", type: "text" },
        {
          providerMetadata: undefined,
          text: "think",
          type: "reasoning",
        },
      ],
      finishReason: "stop",
      model: { modelId: "mock-model-id", provider: "mock-provider" },
      rawFinishReason: "fixture-stop",
      response: {
        id: "response-stream",
        messages: streamResponseMessagesFixture,
        modelId: "response-model",
        timestamp: streamTimestampFixture,
      },
      usage: { ...expectedStreamUsage, raw: streamUsageFixture.raw },
    });
    expect(finalized.finishReason).toBe("stop");
    expect(finalized.response).toEqual({
      headers: undefined,
      id: "response-stream",
      messages: streamResponseMessagesFixture,
      modelId: "response-model",
      timestamp: streamTimestampFixture,
    });
  });

  it("synthesizes committed-order parts for a doGenerate-only model and preserves final parity fields", async () => {
    const generateFixture = {
      content: generateContentFixture,
      finishReason: { raw: "fixture-tools", unified: "tool-calls" },
      request: { body: { prompt: true } },
      response: {
        body: { ok: true },
        headers: { "x-fixture": "generate" },
        id: "response-generate",
        modelId: "response-model",
        timestamp: generateTimestampFixture,
      },
      usage: generateUsageFixture,
      warnings: [],
    } satisfies MockLanguageModelV4GenerateResult;
    const model = createMockLanguageModelV4([generateFixture]);
    const source = createModelStepStream({
      messages: [...prompt],
      model,
      tools: { lookup: lookupTool },
    });

    await expect(collectParts(source.parts)).resolves.toEqual([
      {
        id: "reasoning-0",
        text: "reason one",
        type: "reasoning-delta",
      },
      {
        id: "reasoning-1",
        text: "reason two",
        type: "reasoning-delta",
      },
      { id: "text-0", text: "text one", type: "text-delta" },
      {
        id: "call-1",
        toolName: "lookup",
        type: "tool-input-start",
      },
      {
        delta: JSON.stringify({ city: "Seoul" }),
        id: "call-1",
        type: "tool-input-delta",
      },
      { id: "call-1", type: "tool-input-end" },
      { id: "text-1", text: "text two", type: "text-delta" },
      {
        id: "call-2",
        toolName: "lookup",
        type: "tool-input-start",
      },
      {
        delta: JSON.stringify({ city: "Busan" }),
        id: "call-2",
        type: "tool-input-delta",
      },
      { id: "call-2", type: "tool-input-end" },
    ]);

    const finalized = await source.finalize();
    expect(finalized.responseMessages).toEqual(generateResponseMessagesFixture);
    expect(finalized.usage).toEqual(expectedGenerateUsage);
    expect(finalized.finalStep).toMatchObject({
      finishReason: "tool-calls",
      model: { modelId: "mock-model-id", provider: "mock-provider" },
      rawFinishReason: "fixture-tools",
      response: {
        headers: { "x-fixture": "generate" },
        id: "response-generate",
        messages: generateResponseMessagesFixture,
        modelId: "response-model",
        timestamp: generateTimestampFixture,
      },
      usage: { ...expectedGenerateUsage, raw: generateUsageFixture.raw },
    });
    expect(finalized.finishReason).toBe("tool-calls");
    expect(finalized.response).toEqual({
      body: undefined,
      headers: { "x-fixture": "generate" },
      id: "response-generate",
      messages: generateResponseMessagesFixture,
      modelId: "response-model",
      timestamp: generateTimestampFixture,
    });
  });

  it("observes abort as a part and closes iteration without throwing", async () => {
    const abortController = new AbortController();
    let markModelStarted: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const model = createStreamingMockLanguageModelV4(
      async ({ abortSignal }) => ({
        stream: new ReadableStream<MockStreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            abortSignal?.addEventListener(
              "abort",
              () => controller.error(abortSignal.reason),
              { once: true }
            );
            markModelStarted?.();
          },
        }),
      })
    );
    const source = createModelStepStream({
      abortSignal: abortController.signal,
      messages: [...prompt],
      model,
    });

    const collected = collectParts(source.parts);
    await modelStarted;
    abortController.abort();

    const parts = await collected;
    expect(parts.map((part) => part.type)).toEqual(["start", "abort"]);
    expect(parts.at(-1)).toMatchObject({ type: "abort" });
  });

  it("propagates doGenerate failures through iteration and finalize", async () => {
    const fixtureError = new Error("fixture generate failure");
    const model = createMockLanguageModelV4(() => Promise.reject(fixtureError));
    const source = createModelStepStream({ messages: [...prompt], model });

    await expect(collectParts(source.parts)).rejects.toBe(fixtureError);
    await expect(source.finalize()).rejects.toBe(fixtureError);
  });

  it("preserves doStream failures without logging raw error objects", async () => {
    const fixtureError = new Error("User banned (request id: req-stream)");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const model = createStreamingMockLanguageModelV4(() =>
      Promise.reject(fixtureError)
    );
    const source = createModelStepStream({ messages: [...prompt], model });

    try {
      const parts = await collectParts(source.parts);

      expect(parts.at(-1)).toEqual({ error: fixtureError, type: "error" });
      await expect(source.finalize()).rejects.toBe(fixtureError);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

async function collectParts(
  parts: AsyncIterable<ModelStepStreamPart>
): Promise<ModelStepStreamPart[]> {
  const collected: ModelStepStreamPart[] = [];
  for await (const part of parts) {
    collected.push(part);
  }
  return collected;
}

function selectScriptedParts(
  parts: readonly ModelStepStreamPart[]
): Record<string, unknown>[] {
  const selected: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (part.type === "text-delta" || part.type === "reasoning-delta") {
      selected.push({ id: part.id, text: part.text, type: part.type });
    } else if (part.type === "tool-input-start") {
      selected.push({
        id: part.id,
        toolName: part.toolName,
        type: part.type,
      });
    } else if (part.type === "tool-input-delta") {
      selected.push({ delta: part.delta, id: part.id, type: part.type });
    } else if (part.type === "tool-input-end") {
      selected.push({ id: part.id, type: part.type });
    }
  }
  return selected;
}
