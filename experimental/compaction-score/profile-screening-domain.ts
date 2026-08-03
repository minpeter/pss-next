import type { CampaignRunArtifact } from "./campaign-run-artifact";
import {
  RunArtifactValidationError,
  resolveRegisteredProfile,
} from "./campaign-run-artifact";
import { COMPACTION_PROMPT_PROFILES } from "./prompt-profiles";
import type { PromptProfileIdentity } from "./report";
import { evaluateStabilityComparison } from "./stability-gates";

export interface ScreeningProfileSpec {
  readonly directory: string;
  readonly id: string;
  readonly order: number;
}

export interface ScreeningEntry {
  readonly decision: {
    readonly failureCodes: readonly string[];
    readonly passed: boolean;
  };
  readonly profile: PromptProfileIdentity;
  readonly provider: CampaignRunArtifact["manifest"]["provider"];
  readonly rules: CampaignRunArtifact["rules"];
  readonly seedCapability: CampaignRunArtifact["manifest"]["seedCapability"];
  readonly summary: unknown;
}

export type ScreeningValidationCode =
  | "PROFILE_DUPLICATE"
  | "PROFILE_MANIFEST_MISMATCH"
  | "SCREEN_BASELINE_PROFILE_INVALID"
  | "SCREEN_CAMPAIGN_MISMATCH";

export class ScreeningValidationError extends Error {
  readonly code: ScreeningValidationCode;
  readonly name = "ScreeningValidationError";

  constructor(code: ScreeningValidationCode) {
    super(code);
    this.code = code;
  }
}

export function parseScreeningOptions(args: readonly string[]): {
  readonly baselineDirectory: string;
  readonly profiles: readonly ScreeningProfileSpec[];
} {
  let baselineDirectory: string | undefined;
  const profiles: ScreeningProfileSpec[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--baseline" && value && !value.startsWith("--")) {
      baselineDirectory = value;
      index += 1;
      continue;
    }
    if (flag === "--profile" && value && !value.startsWith("--")) {
      profiles.push(parseProfileSpec(value));
      index += 1;
      continue;
    }
    throw new TypeError("invalid-screening-options");
  }
  if (!baselineDirectory || profiles.length === 0) {
    throw new TypeError("invalid-screening-options");
  }
  if (new Set(profiles.map(({ id }) => id)).size !== profiles.length) {
    throw new ScreeningValidationError("PROFILE_DUPLICATE");
  }
  return {
    baselineDirectory,
    profiles: profiles.sort((left, right) => left.order - right.order),
  };
}

export function createScreeningEntry(
  baseline: CampaignRunArtifact,
  candidate: CampaignRunArtifact,
  expectedProfileId: string
): ScreeningEntry {
  if (candidate.profile.id !== expectedProfileId) {
    throw new ScreeningValidationError("PROFILE_MANIFEST_MISMATCH");
  }
  assertComparableCampaign(baseline, candidate);
  const decision = evaluateStabilityComparison(
    baseline.summary,
    candidate.summary
  );
  return {
    decision: {
      failureCodes: decision.failures.map(({ code }) => code),
      passed: decision.passed,
    },
    profile: candidate.profile,
    provider: candidate.manifest.provider,
    rules: candidate.rules,
    seedCapability: candidate.manifest.seedCapability,
    summary: candidate.summary,
  };
}

export function publicScreeningEntry(entry: ScreeningEntry) {
  return {
    decision: entry.decision,
    profile: entry.profile,
    provider: entry.provider,
    rules: entry.rules,
    seedCapability: entry.seedCapability,
  };
}

export function selectScreeningWinner(
  entries: readonly ScreeningEntry[]
): PromptProfileIdentity | null {
  const passing = entries.filter(({ decision }) => decision.passed);
  passing.sort(
    (left, right) =>
      right.rules.length - left.rules.length ||
      summaryMeanRatio(left.summary) - summaryMeanRatio(right.summary) ||
      summaryVariance(left.summary) - summaryVariance(right.summary) ||
      left.profile.id.localeCompare(right.profile.id)
  );
  return passing[0]?.profile ?? null;
}

function parseProfileSpec(value: string): ScreeningProfileSpec {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new TypeError("invalid-profile-spec");
  }
  const id = value.slice(0, separator);
  const directory = value.slice(separator + 1);
  const registered = resolveRegisteredProfile({ hash: registeredHash(id), id });
  return {
    directory,
    id: registered.id,
    order: COMPACTION_PROMPT_PROFILES.findIndex(
      (profile) => profile.id === registered.id
    ),
  };
}

function registeredHash(id: string): string {
  const profile = COMPACTION_PROMPT_PROFILES.find(
    (candidate) => candidate.id === id
  );
  if (!profile) {
    throw new RunArtifactValidationError("PROFILE_UNKNOWN");
  }
  return profile.hash;
}

function assertComparableCampaign(
  baseline: CampaignRunArtifact,
  candidate: CampaignRunArtifact
): void {
  if (
    JSON.stringify(baseline.manifest.provider) !==
      JSON.stringify(candidate.manifest.provider) ||
    JSON.stringify(baseline.manifest.options) !==
      JSON.stringify(candidate.manifest.options) ||
    baseline.manifest.seedCapability.capability !==
      candidate.manifest.seedCapability.capability
  ) {
    throw new ScreeningValidationError("SCREEN_CAMPAIGN_MISMATCH");
  }
}

function summaryMeanRatio(value: unknown): number {
  return nestedNumber(value, ["compression", "ratio", "mean"]);
}

function summaryVariance(value: unknown): number {
  return nestedNumber(value, [
    "retention",
    "trialAccuracy",
    "standardDeviation",
  ]);
}

function nestedNumber(value: unknown, path: readonly string[]): number {
  let current = value;
  for (const key of path) {
    if (!(typeof current === "object" && current !== null && key in current)) {
      return Number.POSITIVE_INFINITY;
    }
    current = (current as Readonly<Record<string, unknown>>)[key];
  }
  return typeof current === "number" ? current : Number.POSITIVE_INFINITY;
}
