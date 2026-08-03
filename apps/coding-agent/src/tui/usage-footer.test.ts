import type { ModelUsage } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { formatTokens, TokenUsageTracker } from "./usage-footer";

const usage = (partial: Partial<ModelUsage>): ModelUsage => ({
  attemptId: "attempt",
  type: "model-usage",
  ...partial,
});

describe("formatTokens", () => {
  it("prints small counts verbatim and large counts in k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(12_345)).toBe("12.3k");
  });
});

describe("TokenUsageTracker", () => {
  it("shows nothing before any usage or streaming", () => {
    const tracker = new TokenUsageTracker();
    expect(tracker.footerText()).toBeUndefined();
  });

  it("never renders a false 0 tokens claim when usage events carry no numbers", () => {
    const tracker = new TokenUsageTracker();
    // Providers without stream usage report events with all fields missing.
    tracker.addUsage(usage({}));
    expect(tracker.footerText()).toBeUndefined();
  });

  it("shows the latest authoritative usage without recounting prior context", () => {
    const tracker = new TokenUsageTracker();
    tracker.addUsage(usage({ inputTokens: 100, outputTokens: 20 }));
    tracker.addUsage(
      usage({ inputTokens: 900, outputTokens: 180, totalTokens: 1080 })
    );

    expect(tracker.footerText()).toBe("1.1k tokens (900 in / 180 out)");
  });

  it("shows a live estimate while the first step streams", () => {
    const tracker = new TokenUsageTracker();
    tracker.addOutputDelta("x".repeat(400));

    expect(tracker.footerText()).toBe("≈100 tokens");
  });

  it("adds the live estimate on top of committed totals", () => {
    const tracker = new TokenUsageTracker();
    tracker.addUsage(
      usage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 })
    );
    tracker.addOutputDelta("x".repeat(200));

    expect(tracker.footerText()).toBe("≈200 tokens (100 in / 100 out)");
  });

  it("replaces the estimate with real numbers when usage arrives", () => {
    const tracker = new TokenUsageTracker();
    tracker.addOutputDelta("x".repeat(4000));
    tracker.addUsage(
      usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    );

    expect(tracker.footerText()).toBe("15 tokens (10 in / 5 out)");
  });

  it("drops a stale estimate when a new turn begins", () => {
    const tracker = new TokenUsageTracker();
    tracker.addOutputDelta("x".repeat(400));
    tracker.beginTurn();

    expect(tracker.footerText()).toBeUndefined();
  });

  it("reset clears totals and estimate", () => {
    const tracker = new TokenUsageTracker();
    tracker.addUsage(
      usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    );
    tracker.addOutputDelta("estimate");
    tracker.reset();

    expect(tracker.footerText()).toBeUndefined();
  });

  it("derives total when the provider omits totalTokens", () => {
    const tracker = new TokenUsageTracker();
    tracker.addUsage(usage({ inputTokens: 30, outputTokens: 12 }));

    expect(tracker.footerText()).toBe("42 tokens (30 in / 12 out)");
  });
});
