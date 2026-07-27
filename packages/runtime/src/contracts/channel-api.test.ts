import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ChannelAssistantDelivery,
  type ChannelAssistantTextDelivery,
  type ChannelInboundMessage,
  projectChannelAssistantDelivery,
} from "../channel";
import type { AgentEvent, AgentInput, ThreadKey } from "../index";

describe("runtime channel subpath", () => {
  it("exports only the channel delivery projector at runtime", async () => {
    const channel = await import("../channel");

    expect(Object.keys(channel)).toEqual(["projectChannelAssistantDelivery"]);
  });

  it("types the app-owned inbound and delivery contracts", () => {
    expectTypeOf<ChannelInboundMessage>().toEqualTypeOf<{
      readonly input: AgentInput;
      readonly threadKey: ThreadKey;
    }>();
    expectTypeOf<ChannelAssistantTextDelivery>().toEqualTypeOf<{
      readonly text: string;
      readonly type: "assistant-text";
    }>();
    expectTypeOf<ChannelAssistantDelivery>().toEqualTypeOf<ChannelAssistantTextDelivery>();
    expectTypeOf<
      Parameters<typeof projectChannelAssistantDelivery>[0]
    >().toEqualTypeOf<AgentEvent>();
    expectTypeOf<
      ReturnType<typeof projectChannelAssistantDelivery>
    >().toEqualTypeOf<ChannelAssistantDelivery | undefined>();
  });

  it("projects non-empty assistant output without changing its text", () => {
    expect(
      projectChannelAssistantDelivery({
        text: " visible reply ",
        type: "assistant-output",
      })
    ).toEqual({ text: " visible reply ", type: "assistant-text" });
  });

  it("never projects ephemeral stream deltas to channel delivery", () => {
    const streamEvents = [
      { text: "hel", type: "assistant-output-delta" },
      { text: "lo world", type: "assistant-output-delta" },
      { text: "thinking", type: "assistant-reasoning-delta" },
      {
        toolCallId: "call-1",
        toolName: "weather",
        type: "tool-call-input-start",
      },
      {
        inputTextDelta: '{"city":"Seoul"}',
        toolCallId: "call-1",
        type: "tool-call-input-delta",
      },
      { toolCallId: "call-1", type: "tool-call-input-end" },
    ] satisfies readonly AgentEvent[];

    expect(streamEvents.map(projectChannelAssistantDelivery)).toEqual(
      streamEvents.map(() => undefined)
    );
  });

  it("ignores empty assistant output and every non-output event", () => {
    const ignoredEvents = [
      { type: "turn-start" },
      { type: "step-start" },
      { attemptId: "attempt-1", type: "model-usage" },
      { text: "thinking", type: "assistant-reasoning" },
      { text: "user said hi", type: "user-input" },
      {
        input: { text: "runtime says continue", type: "user-input" },
        placement: "turn-start",
        type: "runtime-input",
      },
      {
        input: { city: "Seoul" },
        toolCallId: "call-1",
        toolName: "weather",
        type: "tool-call",
      },
      {
        output: { ok: true },
        toolCallId: "call-1",
        toolName: "weather",
        type: "tool-result",
      },
      { type: "step-end" },
      { message: "failed", type: "turn-error" },
      { type: "turn-abort" },
      { type: "turn-end" },
      { text: "", type: "assistant-output" },
      { text: "   ", type: "assistant-output" },
    ] satisfies readonly AgentEvent[];

    expect(ignoredEvents.map(projectChannelAssistantDelivery)).toEqual(
      ignoredEvents.map(() => undefined)
    );
  });
});
