import { describe, expect, it } from "vitest";
import { normalizeAgentAutoCompactionOptions } from "./options";

const autoCompactionError = /autoCompaction/;
const triggerTokensError = /autoCompaction\.triggerTokens/;
const retainTokensError = /autoCompaction\.retainTokens/;
const estimateTokensError = /autoCompaction\.estimateTokens/;

describe("normalizeAgentAutoCompactionOptions", () => {
  it("defaults to token-based thresholds when autoCompaction is omitted", () => {
    expect(normalizeAgentAutoCompactionOptions(undefined)).toEqual({
      maxInputTokens: 128_000,
      retainTokens: 51_200,
      triggerTokens: 102_400,
    });
  });

  it("applies the same defaults for an empty options object", () => {
    expect(normalizeAgentAutoCompactionOptions({})).toEqual({
      maxInputTokens: 128_000,
      retainTokens: 51_200,
      triggerTokens: 102_400,
    });
  });

  it("derives trigger and retain budgets from a custom context window", () => {
    expect(
      normalizeAgentAutoCompactionOptions({ maxInputTokens: 200_000 })
    ).toEqual({
      maxInputTokens: 200_000,
      retainTokens: 80_000,
      triggerTokens: 160_000,
    });
  });

  it("derives the retain budget from a custom trigger", () => {
    expect(
      normalizeAgentAutoCompactionOptions({ triggerTokens: 50_000 })
    ).toEqual({
      maxInputTokens: 128_000,
      retainTokens: 25_000,
      triggerTokens: 50_000,
    });
  });

  it("rejects the removed off switch", () => {
    expect(() =>
      normalizeAgentAutoCompactionOptions(
        false as unknown as Parameters<
          typeof normalizeAgentAutoCompactionOptions
        >[0]
      )
    ).toThrow(autoCompactionError);
  });

  it.each([
    { maxInputTokens: 0 },
    { maxInputTokens: -5 },
    { maxInputTokens: 1.5 },
    { triggerTokens: 0 },
    { retainTokens: -1 },
  ])("rejects malformed token budgets: %o", (options) => {
    expect(() => normalizeAgentAutoCompactionOptions(options)).toThrow(
      autoCompactionError
    );
  });

  it("rejects a trigger above the context window", () => {
    expect(() =>
      normalizeAgentAutoCompactionOptions({
        maxInputTokens: 100_000,
        triggerTokens: 200_000,
      })
    ).toThrow(triggerTokensError);
  });

  it("rejects a retain budget that leaves no room below the trigger", () => {
    expect(() =>
      normalizeAgentAutoCompactionOptions({
        retainTokens: 60_000,
        triggerTokens: 50_000,
      })
    ).toThrow(retainTokensError);
  });

  it("rejects a non-function token estimator", () => {
    expect(() =>
      normalizeAgentAutoCompactionOptions({
        estimateTokens: 42 as unknown as () => number,
      })
    ).toThrow(estimateTokensError);
  });

  it("derives default thresholds from an explicit context gate", () => {
    expect(
      normalizeAgentAutoCompactionOptions({
        contextGate: { maxInputTokens: 10_000, onOverflow: "error" },
      })
    ).toEqual({
      contextGate: { maxInputTokens: 10_000, onOverflow: "error" },
      maxInputTokens: 128_000,
      retainTokens: 4_000,
      triggerTokens: 8_000,
    });
  });

  it("rejects an explicit trigger above the effective context gate budget", () => {
    expect(() =>
      normalizeAgentAutoCompactionOptions({
        contextGate: { maxInputTokens: 10_000, onOverflow: "compact" },
        triggerTokens: 12_000,
      })
    ).toThrow(triggerTokensError);
  });
});
