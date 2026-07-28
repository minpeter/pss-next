import { describe, expect, it } from "vitest";
import { createAssistantRendererNotifications } from "./assistant-renderer";

describe("assistant renderer notifications", () => {
  it("deduplicates keys for the whole TUI session", () => {
    const messages: string[] = [];
    const notifications = createAssistantRendererNotifications((message) => {
      messages.push(message);
    });

    notifications.notifyOnce("latex:missing", "first");
    notifications.notifyOnce("latex:missing", "duplicate");
    notifications.notifyOnce("other", "second");

    expect(messages).toEqual(["first", "second"]);
  });
});
