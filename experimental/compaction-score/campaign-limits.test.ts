import { describe, expect, it } from "vitest";
import {
  MAX_CAMPAIGN_REPETITIONS,
  parseCampaignRepetitions,
  validateCampaignRepetitions,
} from "./campaign-limits";

describe("campaign repetition ceiling", () => {
  it.each(["0", "101", "1.5", "not-a-number", undefined])(
    "rejects %s",
    (value) => {
      expect(() =>
        parseCampaignRepetitions(value, "Campaign repetitions")
      ).toThrow("between 1 and 100");
    }
  );

  it("accepts the maximum", () => {
    expect(
      parseCampaignRepetitions(String(MAX_CAMPAIGN_REPETITIONS), "test")
    ).toBe(MAX_CAMPAIGN_REPETITIONS);
  });
  it("rejects an oversized parsed artifact repetition before allocation", () => {
    expect(() =>
      validateCampaignRepetitions(
        MAX_CAMPAIGN_REPETITIONS + 1,
        "Artifact repetitions"
      )
    ).toThrow("between 1 and 100");
  });
});
