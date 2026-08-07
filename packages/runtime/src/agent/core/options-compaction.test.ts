import { describe, expect, it } from "vitest";
import { createCallbackModel } from "../../testing/test-fixtures";
import { assertAgentOptions } from "./options";

describe("AgentOptions.compaction", () => {
  it("rejects non-functions and non-policy objects", () => {
    expect(() =>
      assertAgentOptions({
        compaction: 1 as never,
        model: createCallbackModel(() => []),
      })
    ).toThrow(
      "Agent: options.compaction must be a function or a compaction policy."
    );
  });

  it("rejects a policy object without maxInputTokens", () => {
    expect(() =>
      assertAgentOptions({
        compaction: {} as never,
        model: createCallbackModel(() => []),
      })
    ).toThrow("Agent: options.compaction.maxInputTokens must be a function.");
  });

  it("accepts a budget-only policy object", () => {
    expect(() =>
      assertAgentOptions({
        compaction: { maxInputTokens: () => 1, onOverflow: "error" },
        model: createCallbackModel(() => []),
      })
    ).not.toThrow();
  });
});
