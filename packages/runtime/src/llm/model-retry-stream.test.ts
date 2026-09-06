import { APICallError, jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  mockLanguageModelV4Text,
  mockLanguageModelV4ToolCall,
} from "../testing/mock-language-model-v4-test-utils";
import type { ModelRetry, StreamAgentEvent } from "../thread/protocol/events";
import { generateModelStepResult } from "./model-step";
import {
  createModelStepStream,
  type ModelStepStreamPart,
} from "./model-step-stream";

const history = [{ content: "go", role: "user" }] as const;
const failure = () =>
  new APICallError({
    message: "private error",
    requestBodyValues: {},
    responseHeaders: { "retry-after-ms": "0" },
    statusCode: 429,
    url: "https://fixture.test",
  });

describe("retry boundaries after a provider response", () => {
  it.each(["error-part", "stream-error", "missing-finish"] as const)(
    "never retries or duplicates output after %s",
    async (mode) => {
      let calls = 0;
      const error = failure();
      const events: StreamAgentEvent[] = [];
      const model = createStreamingMockLanguageModelV4(() => {
        calls += 1;
        return Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ id: "text", type: "text-start" });
              controller.enqueue({
                delta: "prefix",
                id: "text",
                type: "text-delta",
              });
              controller.enqueue({ id: "text", type: "text-end" });
              if (mode === "error-part") {
                controller.enqueue({ error, type: "error" });
                const { finishReason, usage } = mockLanguageModelV4Text("");
                controller.enqueue({ finishReason, type: "finish", usage });
              }
              if (mode !== "stream-error") {
                controller.close();
              }
            },
            pull(controller) {
              controller.error(error);
            },
          }),
        });
      });
      await generateModelStepResult({
        history,
        model,
        signal: new AbortController().signal,
        onStreamEvent: (event) => events.push(event),
      }).catch((caught: unknown) => {
        expect(caught).toBe(error);
      });
      expect(calls).toBe(1);
      expect(
        events.filter((event) => event.type === "model-retry")
      ).toMatchObject([
        {
          attempt: 1,
          phase: "stopped",
          reason: "stream-ended",
          remainingRetries: 0,
        },
      ]);
      expect(
        events.filter((event) => event.type === "assistant-output-delta")
      ).toEqual([{ text: "prefix", type: "assistant-output-delta" }]);
    }
  );

  it("retries only the non-streaming call and executes its tool once", async () => {
    let calls = 0;
    let executions = 0;
    const events: ModelRetry[] = [];
    const model = createMockLanguageModelV4(() => {
      calls += 1;
      if (calls === 1) {
        throw failure();
      }
      return Promise.resolve(
        mockLanguageModelV4ToolCall({
          input: {},
          toolCallId: "call",
          toolName: "count",
        })
      );
    });
    const handle = createModelStepStream({
      attemptId: "direct-provider-seam",
      messages: [...history],
      model,
      onRetry: (event) => events.push(event),
      tools: {
        count: tool({
          inputSchema: jsonSchema({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          execute: () => {
            executions += 1;
            return "done";
          },
        }),
      },
    });
    const parts: ModelStepStreamPart[] = [];
    for await (const part of handle.parts) {
      parts.push(part);
    }
    const result = await handle.finalize();
    expect(await handle.finalize()).toBe(result);
    expect(calls).toBe(2);
    expect(executions).toBe(1);
    expect(
      parts.filter((part) => part.type === "tool-input-start")
    ).toHaveLength(1);
    expect(events).toMatchObject([
      { attemptId: "direct-provider-seam", phase: "scheduled" },
      { attemptId: "direct-provider-seam", phase: "started" },
    ]);
  });

  it("keeps implicit gateway strings unobserved without making a network call", async () => {
    const original = globalThis.AI_SDK_DEFAULT_PROVIDER;
    globalThis.AI_SDK_DEFAULT_PROVIDER = undefined;
    const controller = new AbortController();
    controller.abort();
    const events: StreamAgentEvent[] = [];
    try {
      await expect(
        generateModelStepResult({
          history,
          model: "openai/fixture",
          signal: controller.signal,
          onStreamEvent: (event) => events.push(event),
        })
      ).rejects.toThrow();
      expect(events).toEqual([]);
    } finally {
      globalThis.AI_SDK_DEFAULT_PROVIDER = original;
    }
  });
});
