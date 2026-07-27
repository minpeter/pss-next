import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import {
  collectTurnDelivery,
  WORKER_AGENT_AUTO_COMPACTION,
  WORKER_AGENT_INSTRUCTIONS,
} from "./agent";

describe("worker-agent auto compaction", () => {
  it("retains fewer tokens than the compaction trigger", () => {
    expect(WORKER_AGENT_AUTO_COMPACTION.triggerTokens).toBeGreaterThan(
      WORKER_AGENT_AUTO_COMPACTION.retainTokens ?? 0
    );
    expect(WORKER_AGENT_AUTO_COMPACTION).toEqual({
      maxInputTokens: 128_000,
      retainTokens: 32_000,
      triggerTokens: 96_000,
    });
  });
});

describe("worker-agent instructions", () => {
  it("uses Apex as the assistant name", () => {
    expect(WORKER_AGENT_INSTRUCTIONS).toContain("You are Apex");
    expect(WORKER_AGENT_INSTRUCTIONS).not.toContain("POKE");
  });

  it("includes Bori-inspired texting style instructions without unsupported execution surfaces", () => {
    const requiredRules = [
      "warm but never flattering",
      "witty only when it fits",
      "No preamble",
      "Match the user's texting style",
      "Do not send emoji unless the user used emoji first",
      "Treat the newest human user message as the source of truth",
      "Use earlier conversation only as context",
      "Do not adapt to non-user messages",
      "If the user is just chatting, do not turn the reply into a help offer",
      "When the user is upset or asks why something went wrong",
      "focus on what the user experienced",
      "Some messaging platforms can make replies less natural",
      "Do not invent product facts, security claims, launch details, prices, or URLs",
      "If the user asks for future reminders, scheduled messages, or background follow-up, explicitly say this worker cannot schedule or send future reminders",
      "Do not mention internal agents, tools, or implementation details",
      "The user sees only messages you send by calling send_message",
      "Every user-visible response must be sent with send_message",
      "A successful send_message call is the only user-visible delivery signal",
      "Assistant text is internal only",
      "Avoid botty phrases",
    ] as const;

    for (const rule of requiredRules) {
      expect(WORKER_AGENT_INSTRUCTIONS).toContain(rule);
    }

    const sessionSearchRules = [
      "You can recall other recent conversations with list_sessions, search_sessions, and read_session",
      "then call read_session for the selected conversation",
      "Only state cross-conversation facts that a tool result actually returned",
    ] as const;

    for (const rule of sessionSearchRules) {
      expect(WORKER_AGENT_INSTRUCTIONS).toContain(rule);
    }

    const excludedSurfaces = [
      "sendmessageto_agent",
      "subagent",
      "display_draft",
      "draftId",
      "emailId",
      "<block>",
      "reacttomessage",
      "querymedia",
      "wait tool",
    ] as const;

    for (const surface of excludedSurfaces) {
      expect(WORKER_AGENT_INSTRUCTIONS.toLowerCase()).not.toContain(
        surface.toLowerCase()
      );
    }

    const hybridRules = [
      "The user normally sees your final text reply after the turn ends",
      "answering normally is fine",
      "the worker will deliver the final text",
    ] as const;

    for (const rule of hybridRules) {
      expect(WORKER_AGENT_INSTRUCTIONS).not.toContain(rule);
    }
  });
});

describe("collectTurnDelivery", () => {
  it("does not treat assistant text as delivered output", async () => {
    await expect(
      collectTurnDelivery(
        runWithEvents([
          { type: "assistant-output", text: "first" },
          { type: "assistant-output", text: "second" },
        ])
      )
    ).resolves.toEqual({ deliveredByTool: false });
  });

  it("rejects when the run contains a turn-error without assistant text", async () => {
    await expect(
      collectTurnDelivery(
        runWithEvents([{ type: "turn-error", message: "model unavailable" }])
      )
    ).rejects.toThrow("model unavailable");
  });

  it("rejects when a turn-error follows assistant text", async () => {
    await expect(
      collectTurnDelivery(
        runWithEvents([
          { type: "assistant-output", text: "partial" },
          { type: "turn-error", message: "tool failed" },
        ])
      )
    ).rejects.toThrow("tool failed");
  });

  it("suppresses fallback text when send_message delivered an answer", async () => {
    await expect(
      collectTurnDelivery(
        runWithEvents([
          {
            output: {
              type: "json",
              value: {
                channel: "chat-1",
                delivered: true,
                messageId: "msg-1",
              },
            },
            toolCallId: "call-1",
            toolName: SEND_MESSAGE_TOOL_NAME,
            type: "tool-result",
          },
          { type: "assistant-output", text: "duplicate" },
        ])
      )
    ).resolves.toEqual({ deliveredByTool: true });
  });

  it("treats any successful send_message result as delivered output", async () => {
    await expect(
      collectTurnDelivery(
        runWithEvents([
          {
            output: {
              type: "json",
              value: {
                channel: "chat-1",
                delivered: true,
                messageId: "msg-1",
              },
            },
            toolCallId: "call-1",
            toolName: SEND_MESSAGE_TOOL_NAME,
            type: "tool-result",
          },
          { type: "assistant-output", text: "duplicate" },
        ])
      )
    ).resolves.toEqual({ deliveredByTool: true });
  });
});

function runWithEvents(events: readonly AgentEvent[]): AgentTurn {
  return {
    events: () => eventStream(events),
  };
}

async function* eventStream(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  yield* events;
}
