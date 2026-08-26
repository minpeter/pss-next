export const COMPARISON_SUMMARY_OUTPUT_BUDGET = {
  maxCharacters: 8192,
  maxOutputTokens: 2048,
} as const;

export const PROVIDER_TIMEOUT_MS = 120_000;
export const MAX_ATTEMPTS = 3;
export const REPETITIONS = 2;
export const ORIGINAL_SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
] as const;
export const HOLDOUT_SCENARIOS = [
  "holdout-json",
  "holdout-cjk",
  "holdout-log",
] as const;
export const COMPARISON_SCENARIOS = [
  ...ORIGINAL_SCENARIOS,
  ...HOLDOUT_SCENARIOS,
] as const;

export type ComparisonScenario = (typeof COMPARISON_SCENARIOS)[number];
