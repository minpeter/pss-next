import { buildCompactionSummaryInstructions } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import {
  COMPACTION_PROMPT_PROFILES,
  type SenpiRuleId,
} from "./prompt-profiles";

const TRANSFERABLE_RULES = [
  "byte-exact-identifiers",
  "internal-control-isolation",
  "output-only",
  "section-completeness",
  "task-intent-prepass",
  "update-merge",
  "verbatim-active-request-constraints",
] as const satisfies readonly SenpiRuleId[];

const RETAINED_RULES = [
  "internal-control-isolation",
  "task-intent-prepass",
  "verbatim-active-request-constraints",
] as const satisfies readonly SenpiRuleId[];

const ATOMIC_PROFILE_BY_RULE = {
  "byte-exact-identifiers": "senpi-byte-exact",
  "internal-control-isolation": "senpi-internal-control",
  "output-only": "senpi-output-only",
  "section-completeness": "senpi-section-complete",
  "task-intent-prepass": "senpi-task-intent",
  "update-merge": "senpi-update-merge",
  "verbatim-active-request-constraints": "senpi-verbatim-request",
} as const satisfies Readonly<Record<SenpiRuleId, string>>;

describe("Senpi compaction prompt profiles", () => {
  it("preserves the frozen production prompt", () => {
    const production = COMPACTION_PROMPT_PROFILES.find(
      ({ id }) => id === "production"
    );

    expect(production?.instructions).toBe(buildCompactionSummaryInstructions());
    expect(production?.hash).toBe(
      "sha256:7ea878eb30458a20fb20ed6e41e2987cf91e1f76e2d8fba46c477cd24f86f38c"
    );
  });

  it("defines one atomic live-screening profile for every transferable rule", () => {
    const profiles = new Map(
      COMPACTION_PROMPT_PROFILES.map((profile) => [profile.id, profile])
    );

    for (const rule of TRANSFERABLE_RULES) {
      const expectedRules = RETAINED_RULES.includes(
        rule as (typeof RETAINED_RULES)[number]
      )
        ? [rule]
        : [...RETAINED_RULES, rule];
      expect(profiles.get(ATOMIC_PROFILE_BY_RULE[rule])?.rules).toEqual(
        expectedRules
      );
    }
  });

  it("keeps a cumulative maximal bundle covering the complete rule inventory", () => {
    const maximal = COMPACTION_PROMPT_PROFILES.find(
      ({ id }) => id === "senpi-maximal"
    );

    expect([...(maximal?.rules ?? [])].sort()).toEqual(TRANSFERABLE_RULES);
    expect(
      new Set(COMPACTION_PROMPT_PROFILES.map(({ hash }) => hash)).size
    ).toBe(COMPACTION_PROMPT_PROFILES.length - 1);
  });
});
