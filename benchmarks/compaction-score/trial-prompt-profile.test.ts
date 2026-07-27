import { describe, expect, it } from "vitest";
import { getCompactionPromptProfile } from "./prompt-profiles";
import { trialPromptProfile } from "./trial-prompt-profile";

describe("benchmark trial prompt profile", () => {
  it("attributes production without overriding its default instruction path", () => {
    const production = getCompactionPromptProfile("production");

    expect(trialPromptProfile("production")).toEqual({
      profile: { hash: production.hash, id: production.id },
    });
  });

  it("attributes a candidate and supplies its benchmark-only override", () => {
    const candidate = getCompactionPromptProfile("senpi-maximal");

    expect(trialPromptProfile(candidate.id)).toEqual({
      profile: { hash: candidate.hash, id: candidate.id },
      summaryInstructions: candidate.instructions,
    });
  });
});
