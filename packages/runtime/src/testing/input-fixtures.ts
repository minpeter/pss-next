import type {
  UserMessage,
  UserMessageContent,
  UserText,
  UserTextContent,
} from "../thread/protocol/events";

export const userText = (text: UserTextContent): UserText => ({
  type: "user-input",
  text,
});

export const sentUserText = (text: UserTextContent): UserText => ({
  meta: { source: "send" },
  text,
  type: "user-input",
});

export const userMessage = (content: UserMessageContent): UserMessage => ({
  type: "user-input",
  content,
});

export const steerRuntimeInput = (
  text: UserTextContent,
  placement: "step-end" | "step-start" | "turn-start"
) => ({
  input: {
    meta: { source: "steer", streaming: "steer" as const },
    text,
    type: "user-input" as const,
  },
  meta: { source: "steer" as const, streaming: "steer" as const },
  placement,
  type: "runtime-input" as const,
});

export const notifyRuntimeInput = (
  text: UserTextContent,
  placement: "step-end" | "step-start" | "turn-start" = "turn-start"
) => ({
  input: {
    meta: { source: "notify" as const },
    text,
    type: "user-input" as const,
  },
  meta: { source: "notify" as const },
  placement,
  type: "runtime-input" as const,
});

export const overlayRuntimeInput = (
  text: UserTextContent,
  placement: "step-end" | "step-start" | "turn-start" = "turn-start"
) => ({
  input: {
    meta: { source: "overlay" as const },
    text,
    type: "user-input" as const,
  },
  meta: { source: "overlay" as const },
  placement,
  type: "runtime-input" as const,
});
