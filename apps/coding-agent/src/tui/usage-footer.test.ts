import type {
  ContextUsageSnapshot,
  TokenEstimate,
} from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { contextUsageFooter, formatTokens } from "./usage-footer";

const estimate = (
  tokens: number,
  basis: TokenEstimate["basis"]
): TokenEstimate => ({
  basis,
  marginTokens: 0,
  tokens,
});

describe("contextUsageFooter", () => {
  it("formats runtime snapshots and marks only estimates", () => {
    const snapshot: ContextUsageSnapshot = {
      calibration: { observations: 1, revision: 1 },
      currentRequest: {
        input: estimate(1000, "reported"),
        output: estimate(20, "calibrated"),
        total: estimate(1020, "calibrated"),
      },
    };
    expect(contextUsageFooter(snapshot)).toBe(
      "≈1.0k tokens (1.0k in / ≈20 out)"
    );
  });

  it("hides an empty snapshot", () => {
    expect(
      contextUsageFooter({
        calibration: { observations: 0, revision: 0 },
        currentRequest: {
          input: estimate(0, "heuristic"),
          output: estimate(0, "heuristic"),
          total: estimate(0, "heuristic"),
        },
      })
    ).toBeUndefined();
  });
});

describe("formatTokens", () => {
  it("abbreviates thousands", () => expect(formatTokens(12_345)).toBe("12.3k"));
});
