import {
  type CampaignBenchmarkOptions,
  copyManifestCapability,
  copyManifestOptions,
  copyManifestProfile,
  copyManifestProvider,
  invalidCampaignManifest,
  isManifestRecord,
  parseManifestCapability,
  parseManifestOptions,
  parseManifestProfile,
  parseManifestProvider,
} from "./campaign-manifest-fields";
import type { ProviderCampaignIdentity } from "./provider-campaign";
import type { PromptProfileIdentity } from "./report";
import type { SeedCapabilityReport } from "./seed-preflight";

export type { CampaignBenchmarkOptions } from "./campaign-manifest-fields";

export interface CampaignManifest {
  readonly createdAt: string;
  readonly mode: "benchmark" | "preflight";
  readonly options: CampaignBenchmarkOptions;
  readonly profile: PromptProfileIdentity;
  readonly protocol: CampaignProtocol;
  readonly provider: ProviderCampaignIdentity;
  readonly schemaVersion: 1;
  readonly seedCapability: SeedCapabilityReport;
}

interface CampaignProtocol {
  readonly answerCallsPerTrial: 2;
  readonly armOrder: "rotated by repetition";
  readonly fullControlRequired: true;
  readonly score: "compacted exact-match retention";
  readonly summaryCallsPerTrial: "fixture compaction hop count";
  readonly summarySeed:
    | "deterministic per attempt and hop"
    | "omitted after unsupported seeded preflight";
  readonly temperature: 0;
}

export interface PreflightReport {
  readonly provider: ProviderCampaignIdentity;
  readonly schemaVersion: 1;
  readonly seedCapability: SeedCapabilityReport;
  readonly status: "passed";
}

interface CampaignManifestInput {
  readonly createdAt: string;
  readonly mode: CampaignManifest["mode"];
  readonly options: CampaignBenchmarkOptions;
  readonly profile: PromptProfileIdentity;
  readonly provider: ProviderCampaignIdentity;
  readonly seedCapability: SeedCapabilityReport;
}

export function createCampaignManifest(
  input: CampaignManifestInput
): CampaignManifest {
  const omitted = input.seedCapability.capability === "unsupported";
  if (input.options.omitSummarySeed !== omitted) {
    return invalidCampaignManifest();
  }
  return {
    createdAt: input.createdAt,
    mode: input.mode,
    options: copyManifestOptions(input.options),
    profile: copyManifestProfile(input.profile),
    protocol: protocolFor(input.options.omitSummarySeed),
    provider: copyManifestProvider(input.provider),
    schemaVersion: 1,
    seedCapability: copyManifestCapability(input.seedCapability),
  };
}

export function createPreflightReport(
  provider: ProviderCampaignIdentity,
  seedCapability: SeedCapabilityReport
): PreflightReport {
  return {
    provider: copyManifestProvider(provider),
    schemaVersion: 1,
    seedCapability: copyManifestCapability(seedCapability),
    status: "passed",
  };
}

export function parseCampaignManifest(value: unknown): CampaignManifest {
  try {
    if (!isManifestRecord(value) || value.schemaVersion !== 1) {
      return invalidCampaignManifest();
    }
    if (
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return invalidCampaignManifest();
    }
    const mode =
      value.mode === "benchmark" || value.mode === "preflight"
        ? value.mode
        : invalidCampaignManifest();
    const manifest = createCampaignManifest({
      createdAt: value.createdAt,
      mode,
      options: parseManifestOptions(value.options),
      profile: parseManifestProfile(value.profile),
      provider: parseManifestProvider(value.provider),
      seedCapability: parseManifestCapability(value.seedCapability),
    });
    if (!sameProtocol(value.protocol, manifest.protocol)) {
      return invalidCampaignManifest();
    }
    return manifest;
  } catch {
    return invalidCampaignManifest();
  }
}

function protocolFor(omitSummarySeed: boolean): CampaignProtocol {
  return {
    answerCallsPerTrial: 2,
    armOrder: "rotated by repetition",
    fullControlRequired: true,
    score: "compacted exact-match retention",
    summaryCallsPerTrial: "fixture compaction hop count",
    summarySeed: omitSummarySeed
      ? "omitted after unsupported seeded preflight"
      : "deterministic per attempt and hop",
    temperature: 0,
  };
}

function sameProtocol(value: unknown, expected: CampaignProtocol): boolean {
  if (!isManifestRecord(value)) {
    return false;
  }
  return (Object.keys(expected) as (keyof CampaignProtocol)[]).every(
    (key) => value[key] === expected[key]
  );
}
