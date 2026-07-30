import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { sessionHistoryReplayParts } from "./session-history-replay";

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
});
