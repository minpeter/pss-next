import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  resumeSessionReplayParts,
  sessionHistoryReplayParts,
} from "./session-history-replay";

describe("sessionHistoryReplayParts", () => {
  it("replays stored user and assistant messages in order", () => {
    const history: readonly ModelMessage[] = [
      { content: "hello", role: "user" },
      { content: "welcome back", role: "assistant" },
    ];

    expect(sessionHistoryReplayParts(history)).toEqual([
      { type: "clear" },
      { text: "hello", type: "user" },
      { part: { type: "text-start" }, type: "stream" },
      {
        part: { text: "welcome back", type: "text-delta" },
        type: "stream",
      },
      { part: { type: "text-end" }, type: "stream" },
    ]);
  });

  it("clears stale transcript content for empty histories", () => {
    expect(sessionHistoryReplayParts([])).toEqual([{ type: "clear" }]);
  });

  it("switches sessions before loading and replaying durable history", async () => {
    const events: string[] = [];
    const history: readonly ModelMessage[] = [
      { content: "hello", role: "user" },
      { content: "welcome back", role: "assistant" },
    ];
    const replay = await resumeSessionReplayParts(
      {
        loadCurrentHistory: vi.fn(() => {
          events.push("load");
          return Promise.resolve(history);
        }),
        switchSession: vi.fn((sessionKey) => {
          events.push(`switch:${sessionKey}`);
          return Promise.resolve();
        }),
      },
      "session-2"
    );

    expect(events).toEqual(["switch:session-2", "load"]);
    expect(replay).toContainEqual({ text: "hello", type: "user" });
    expect(replay).toContainEqual({
      part: { text: "welcome back", type: "text-delta" },
      type: "stream",
    });
  });
});
