import {
  CampaignValidationError,
  hasControlCharacters,
  type ProviderCampaignIdentity,
  sanitizeProviderCampaignIdentity,
} from "./provider-campaign";
import type { PromptProfileIdentity } from "./report";
import type { SeedCapabilityReport } from "./seed-preflight";

const PROFILE_HASH_PATTERN = /^sha256:[\da-f]{64}$/u;

export interface CampaignBenchmarkOptions {
  readonly fixtures: number;
  readonly maxAttempts: number;
  readonly omitSummarySeed: boolean;
  readonly seed: string;
  readonly summaryMaxOutputTokens: number;
  readonly trials: number;
}

export function copyManifestOptions(
  options: CampaignBenchmarkOptions
): CampaignBenchmarkOptions {
  return {
    fixtures: options.fixtures,
    maxAttempts: options.maxAttempts,
    omitSummarySeed: options.omitSummarySeed,
    seed: options.seed,
    summaryMaxOutputTokens: options.summaryMaxOutputTokens,
    trials: options.trials,
  };
}

export function parseManifestOptions(value: unknown): CampaignBenchmarkOptions {
  if (!isManifestRecord(value)) {
    return invalidCampaignManifest();
  }
  return {
    fixtures: positiveInteger(value.fixtures),
    maxAttempts: positiveInteger(value.maxAttempts),
    omitSummarySeed:
      typeof value.omitSummarySeed === "boolean"
        ? value.omitSummarySeed
        : invalidCampaignManifest(),
    seed: safeString(value.seed),
    summaryMaxOutputTokens: positiveInteger(value.summaryMaxOutputTokens),
    trials: positiveInteger(value.trials),
  };
}

export function copyManifestProfile(
  profile: PromptProfileIdentity
): PromptProfileIdentity {
  const id = safeString(profile.id);
  const hash = safeString(profile.hash);
  if (!PROFILE_HASH_PATTERN.test(hash)) {
    return invalidCampaignManifest();
  }
  return { hash, id };
}

export function parseManifestProfile(value: unknown): PromptProfileIdentity {
  if (!isManifestRecord(value)) {
    return invalidCampaignManifest();
  }
  return copyManifestProfile({
    hash: safeString(value.hash),
    id: safeString(value.id),
  });
}

export function copyManifestProvider(
  provider: ProviderCampaignIdentity
): ProviderCampaignIdentity {
  return sanitizeProviderCampaignIdentity({
    baseUrl: provider.baseOrigin,
    label: provider.label,
    modelId: provider.modelId,
  });
}

export function parseManifestProvider(
  value: unknown
): ProviderCampaignIdentity {
  if (!isManifestRecord(value)) {
    return invalidCampaignManifest();
  }
  const baseOrigin = safeString(value.baseOrigin);
  const label = safeString(value.label);
  const modelId = safeString(value.modelId);
  const provider = sanitizeProviderCampaignIdentity({
    baseUrl: baseOrigin,
    label,
    modelId,
  });
  if (
    provider.baseOrigin !== baseOrigin ||
    provider.label !== label ||
    provider.modelId !== modelId
  ) {
    return invalidCampaignManifest();
  }
  return provider;
}

export function parseManifestCapability(value: unknown): SeedCapabilityReport {
  if (!isManifestRecord(value)) {
    return invalidCampaignManifest();
  }
  if (
    value.capability === "supported" &&
    value.status === "seeded-probe-succeeded"
  ) {
    return { capability: "supported", status: "seeded-probe-succeeded" };
  }
  if (
    value.capability === "unsupported" &&
    value.status === "seeded-probe-rejected-seedless-probe-succeeded"
  ) {
    return {
      capability: "unsupported",
      status: "seeded-probe-rejected-seedless-probe-succeeded",
    };
  }
  return invalidCampaignManifest();
}

export function copyManifestCapability(
  value: SeedCapabilityReport
): SeedCapabilityReport {
  return value.capability === "supported"
    ? { capability: "supported", status: "seeded-probe-succeeded" }
    : {
        capability: "unsupported",
        status: "seeded-probe-rejected-seedless-probe-succeeded",
      };
}

export function isManifestRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalidCampaignManifest(): never {
  throw new CampaignValidationError("campaign-manifest-invalid");
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : invalidCampaignManifest();
}

function safeString(value: unknown): string {
  return typeof value === "string" &&
    value.length > 0 &&
    !hasControlCharacters(value)
    ? value
    : invalidCampaignManifest();
}
