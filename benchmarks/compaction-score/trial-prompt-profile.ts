import { getCompactionPromptProfile } from "./prompt-profiles";
import type { PromptProfileIdentity } from "./report";

export interface TrialPromptProfile {
  readonly profile: PromptProfileIdentity;
  readonly summaryInstructions?: string;
}

export function trialPromptProfile(profileId: string): TrialPromptProfile {
  const profile = getCompactionPromptProfile(profileId);
  const identity = { hash: profile.hash, id: profile.id };
  return profile.id === "production"
    ? { profile: identity }
    : { profile: identity, summaryInstructions: profile.instructions };
}
