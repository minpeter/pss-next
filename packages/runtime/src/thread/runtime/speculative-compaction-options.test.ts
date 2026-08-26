import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COMPACTION_DEADLINE_MS,
  MAX_COMPACTION_DEADLINE_MS,
} from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";
import { message } from "./speculative-compaction-test-support";

describe("speculativeCompaction", () => {
  it.each([
    { maxInputTokens: 0 },
    { prepareRatio: 0 },
    { promoteRatio: 1 },
    { prepareRatio: 0.9, promoteRatio: 0.8 },
  ])("rejects invalid factory options: %o", (options) => {
    expect(() => speculativeCompaction(options)).toThrow(TypeError);
  });

  it("accepts the timer-safe deadline boundary and rejects above it", () => {
    const atBoundary = speculativeCompaction({
      deadlineMs: MAX_COMPACTION_DEADLINE_MS,
    });

    expect(atBoundary.deadlineMs?.()).toBe(MAX_COMPACTION_DEADLINE_MS);
    expect(() =>
      speculativeCompaction({ deadlineMs: MAX_COMPACTION_DEADLINE_MS + 1 })
    ).toThrow(TypeError);
  });

  it("exposes its budget through the policy surface without an estimator", () => {
    const compaction = speculativeCompaction({ maxInputTokens: 100 });

    expect(compaction.deadlineMs?.()).toBe(DEFAULT_COMPACTION_DEADLINE_MS);
    expect(compaction.estimateTokens).toBeUndefined();
    expect(compaction.maxInputTokens?.()).toBe(100);
    expect(compaction.onOverflow).toBe("compact");
  });

  it("preserves an explicit token estimator as a complete override", () => {
    const estimateTokens = vi.fn(() => 17);
    const compaction = speculativeCompaction({ estimateTokens });

    expect(
      compaction.estimateTokens?.({
        instructions: "system",
        messages: [message("user")],
      })
    ).toBe(17);
    expect(estimateTokens).toHaveBeenCalledWith([
      { content: "system", role: "system" },
      message("user"),
    ]);
  });
});
