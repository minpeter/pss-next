import type { AgentEvent, ModelUsage } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import { agentEventStreamParts } from "./agent-event-stream";
import type { TuiStreamPart } from "./stream-handlers";

const collect = async (
  events: AgentEvent[],
  options?: { onModelUsage?: (usage: ModelUsage) => void }
): Promise<TuiStreamPart[]> => {
  const parts: TuiStreamPart[] = [];
  const source = (async function* () {
    yield* events;
  })();
  for await (const part of agentEventStreamParts(source, options)) {
    parts.push(part);
  }
  return parts;
};

describe("agentEventStreamParts", () => {
  it("streams assistant text deltas without replaying the committed text", async () => {
    const parts = await collect([
      { type: "step-start" },
      { type: "assistant-output-delta", text: "Hello" },
      { type: "assistant-output-delta", text: " world" },
      { type: "assistant-output", text: "Hello world" },
      { type: "step-end" },
    ]);

    expect(parts).toEqual([
      { type: "start-step" },
      { type: "text-start" },
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
      { type: "text-end" },
      { type: "finish-step", finishReason: undefined },
    ]);
  });

  it("falls back to one whole-text delta for committed-only output", async () => {
    const parts = await collect([
      { type: "step-start" },
      { type: "assistant-output", text: "Hi" },
      { type: "step-end" },
    ]);

    expect(parts).toEqual([
      { type: "start-step" },
      { type: "text-start" },
      { type: "text-delta", text: "Hi" },
      { type: "text-end" },
      { type: "finish-step", finishReason: undefined },
    ]);
  });

  it("resets text-delta deduplication at each step", async () => {
    const parts = await collect([
      { type: "step-start" },
      { type: "assistant-output-delta", text: "streamed" },
      { type: "assistant-output", text: "streamed" },
      { type: "step-end" },
      { type: "step-start" },
      { type: "assistant-output", text: "fallback" },
      { type: "step-end" },
    ]);

    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      { type: "text-delta", text: "streamed" },
      { type: "text-delta", text: "fallback" },
    ]);
  });

  it("streams reasoning deltas without replaying the committed reasoning", async () => {
    const parts = await collect([
      { type: "step-start" },
      { type: "assistant-reasoning-delta", text: "Think" },
      { type: "assistant-reasoning-delta", text: " more" },
      { type: "assistant-reasoning", text: "Think more" },
      { type: "step-end" },
    ]);

    expect(parts).toEqual([
      { type: "start-step" },
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "Think" },
      { type: "reasoning-delta", text: " more" },
      { type: "reasoning-end" },
      { type: "finish-step", finishReason: undefined },
    ]);
  });

  it("falls back to one whole-text delta for committed-only reasoning", async () => {
    const parts = await collect([
      { type: "step-start" },
      { type: "assistant-reasoning", text: "thinking" },
      { type: "step-end" },
    ]);

    expect(parts).toEqual([
      { type: "start-step" },
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "thinking" },
      { type: "reasoning-end" },
      { type: "finish-step", finishReason: undefined },
    ]);
  });

  it("maps streamed tool-call input with toolCallId preserved", async () => {
    const parts = await collect([
      {
        type: "tool-call-input-start",
        toolCallId: "call_stream",
        toolName: "shell_execute",
      },
      {
        type: "tool-call-input-delta",
        inputTextDelta: '{"command":"ls"}',
        toolCallId: "call_stream",
      },
      { type: "tool-call-input-end", toolCallId: "call_stream" },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-input-start",
        toolCallId: "call_stream",
        toolName: "shell_execute",
      },
      {
        type: "tool-input-delta",
        inputTextDelta: '{"command":"ls"}',
        toolCallId: "call_stream",
      },
      { type: "tool-input-end", toolCallId: "call_stream" },
    ]);
  });

  it("maps committed-only tool calls and results to their stream parts", async () => {
    const parts = await collect([
      {
        type: "tool-call",
        input: { command: "ls" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
      {
        type: "tool-result",
        output: "ok",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-call",
        input: { command: "ls" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
      {
        type: "tool-result",
        output: "ok",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);
  });

  it("routes error-shaped tool outputs to tool-error parts", async () => {
    const parts = await collect([
      {
        type: "tool-result",
        output: { type: "error-text", value: "boom" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-error",
        error: "boom",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);
  });

  it("unwraps text-typed tool outputs to the raw string", async () => {
    const parts = await collect([
      {
        type: "tool-result",
        output: { type: "text", value: "OK - command finished\nexit_code: 0" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-result",
        output: "OK - command finished\nexit_code: 0",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);
  });

  it("unwraps json-typed tool outputs to the raw value", async () => {
    const results = [{ title: "t", url: "https://a.dev" }];
    const parts = await collect([
      {
        type: "tool-result",
        output: { type: "json", value: results },
        toolCallId: "call_1",
        toolName: "web_search",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-result",
        output: results,
        toolCallId: "call_1",
        toolName: "web_search",
      },
    ]);
  });

  it("maps execution-denied outputs to tool-output-denied parts", async () => {
    const parts = await collect([
      {
        type: "tool-result",
        output: { type: "execution-denied", reason: "policy" },
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);

    expect(parts).toEqual([
      {
        reason: "policy",
        type: "tool-output-denied",
        toolCallId: "call_1",
        toolName: "shell_execute",
      },
    ]);
  });

  it("forwards model-usage to the callback and tracks the last finish reason", async () => {
    const onModelUsage = vi.fn();
    const parts = await collect(
      [
        {
          type: "model-usage",
          attemptId: "a1",
          finishReason: "stop",
          inputTokens: 10,
          outputTokens: 5,
        },
        { type: "step-end" },
        { type: "turn-end" },
      ],
      { onModelUsage }
    );

    expect(onModelUsage).toHaveBeenCalledTimes(1);
    expect(parts).toEqual([
      { type: "finish-step", finishReason: "stop" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("does not inherit a finish reason from an earlier model attempt", async () => {
    const parts = await collect([
      {
        attemptId: "a1",
        finishReason: "tool-calls",
        inputTokens: 10,
        outputTokens: 5,
        type: "model-usage",
      },
      {
        attemptId: "a2",
        inputTokens: 8,
        outputTokens: 3,
        type: "model-usage",
      },
      { type: "step-end" },
      { type: "turn-end" },
    ]);

    expect(parts).toEqual([
      { finishReason: undefined, type: "finish-step" },
      { finishReason: "stop", type: "finish" },
    ]);
  });

  it("defaults the finish reason to stop when no usage was reported", async () => {
    const parts = await collect([{ type: "turn-end" }]);
    expect(parts).toEqual([{ type: "finish", finishReason: "stop" }]);
  });

  it("maps turn lifecycle events to start/abort/error parts", async () => {
    const parts = await collect([
      { type: "turn-start" },
      { type: "step-start" },
      { type: "turn-abort" },
    ]);

    expect(parts).toEqual([
      { type: "start" },
      { type: "start-step" },
      { type: "abort", reason: "interrupted" },
    ]);

    const legacyErrorParts = await collect([
      {
        type: "turn-error",
        message: "User banned (request id: req-stream)",
      },
    ]);
    expect(legacyErrorParts).toEqual([
      {
        type: "error",
        error: {
          message: "User banned (request id: req-stream)",
          title: "Request failed",
        },
      },
    ]);

    const structuredErrorParts = await collect([
      {
        error: {
          category: "permission",
          correlationIds: [{ source: "x-request-id", value: "req-structured" }],
          observedRetryable: false,
          status: 403,
          version: 1,
        },
        message: "Account access denied",
        type: "turn-error",
      } as AgentEvent,
    ]);
    expect(structuredErrorParts).toEqual([
      {
        type: "error",
        error: {
          correlationIds: [{ source: "x-request-id", value: "req-structured" }],
          hint: "Check your provider account or model access.",
          message: "Account access denied",
          title: "Request refused",
        },
      },
    ]);

    const unsafeMetadataParts = await collect([
      {
        error: {
          category: "permission",
          correlationIds: [
            {
              source: "x-request-id\u009b2J",
              value: "request\u001b[2J",
            },
          ],
          version: 1,
        },
        message: "Access denied",
        type: "turn-error",
      } as AgentEvent,
    ]);
    expect(unsafeMetadataParts).toEqual([
      {
        type: "error",
        error: {
          correlationIds: [
            {
              source: "x-request-id\\u009b2J",
              value: "request^[[2J",
            },
          ],
          hint: "Check your provider account or model access.",
          message: "Access denied",
          title: "Request refused",
        },
      },
    ]);
  });

  it("skips user-input and runtime-input echoes", async () => {
    const parts = await collect([
      { type: "user-input", text: "hi" } as AgentEvent,
      { type: "assistant-output", text: "hello" },
    ]);

    expect(parts).toEqual([
      { type: "text-start" },
      { type: "text-delta", text: "hello" },
      { type: "text-end" },
    ]);
  });
});
