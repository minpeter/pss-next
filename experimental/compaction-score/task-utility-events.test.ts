import { describe, expect, it } from "vitest";
import { taskUtilityAssistantOutput } from "./task-utility-events";

describe("task utility assistant output", () => {
  it("uses stream deltas without duplicating the final output event", () => {
    const events = [
      { text: "done", type: "assistant-output" },
      { text: "do", type: "assistant-output-delta" },
      { text: "ne", type: "assistant-output-delta" },
    ];

    expect(taskUtilityAssistantOutput(events)).toBe("done");
  });
});
