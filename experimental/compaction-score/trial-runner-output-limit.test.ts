import { describe, expect, it } from "vitest";
import { trialSummaryOutputTokenLimit } from "./trial-runner";

describe("trial runner summary output limit", () => {
  it("passes the exact requested 256-token cap", () => {
    expect(trialSummaryOutputTokenLimit(256)).toBe(256);
  });

  it("rejects invalid requested caps", () => {
    expect(() => trialSummaryOutputTokenLimit(0)).toThrow("positive integer");
  });
});
