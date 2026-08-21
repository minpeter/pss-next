import { describe, expect, it } from "vitest";
import { createCallbackModel } from "../../testing/test-fixtures";
import { assertAgentOptions } from "./options";

describe("AgentOptions.compaction", () => {
  it("rejects non-functions", () => {
    expect(() =>
      assertAgentOptions({
        compaction: {} as never,
        model: createCallbackModel(() => []),
      })
    ).toThrow("Agent: options.compaction must be a function.");
  });

  it("rejects a function with a non-function maxInputTokens property", () => {
    expect(() =>
      assertAgentOptions({
        compaction: Object.assign(() => undefined, { maxInputTokens: 1 }),
        model: createCallbackModel(() => []),
      })
    ).toThrow("Agent: options.compaction.maxInputTokens must be a function.");
  });

  it("rejects a function with a non-function deadlineMs property", () => {
    expect(() =>
      assertAgentOptions({
        compaction: Object.assign(() => undefined, { deadlineMs: 5000 }),
        model: createCallbackModel(() => []),
      })
    ).toThrow("Agent: options.compaction.deadlineMs must be a function.");
  });

  it("rejects a function with an invalid onOverflow property", () => {
    expect(() =>
      assertAgentOptions({
        compaction: Object.assign(() => undefined, { onOverflow: "retry" }),
        model: createCallbackModel(() => []),
      })
    ).toThrow(
      'Agent: options.compaction.onOverflow must be "compact" or "error".'
    );
  });

  it("accepts a function carrying budget properties", () => {
    expect(() =>
      assertAgentOptions({
        compaction: Object.assign(() => undefined, {
          deadlineMs: () => 5000,
          maxInputTokens: () => 1,
          onOverflow: "error",
        }),
        model: createCallbackModel(() => []),
      })
    ).not.toThrow();
  });
});
