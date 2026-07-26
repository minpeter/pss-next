import type { AgentHooks } from "@minpeter/pss-runtime";

export function createConversationHooks(): AgentHooks {
  return {
    acceptInput(event) {
      if (
        event.type !== "user-input" ||
        !("text" in event) ||
        typeof event.text !== "string"
      ) {
        return;
      }

      return {
        action: "transform",
        value: {
          ...event,
          text: `[user] ${event.text}`,
        },
      };
    },
  };
}
