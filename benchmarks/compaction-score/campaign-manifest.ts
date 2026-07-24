import {
  CampaignValidationError,
  hasControlCharacters,
  type ProviderCampaignIdentity,
  sanitizeProviderCampaignIdentity,
} from "./provider-campaign";
import type { SeedCapabilityReport } from "./seed-preflight";

export interface CampaignBenchmarkOptions {
  readonly fixtures: number;
  readonly maxAttempts: number;
  readonly omitSummarySeed: boolean;
  readonly seed: string;
  readonly summaryMaxOutputTokens: number;
  readonly trials: number;
}

export interface CampaignManifest {
  readonly createdAt: string;
  readonly mode: "benchmark" | "preflight";
  readonly options: CampaignBenchmarkOptions;
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
  readonly provider: ProviderCampaignIdentity;
  readonly seedCapability: SeedCapabilityReport;
}

export function createCampaignManifest(
  input: CampaignManifestInput
): CampaignManifest {
  const omitted = input.seedCapability.capability === "unsupported";
  if (input.options.omitSummarySeed !== omitted) {
    return invalidManifest();
  }
  return {
    createdAt: input.createdAt,
    mode: input.mode,
    options: {
      fixtures: input.options.fixtures,
      maxAttempts: input.options.maxAttempts,
      omitSummarySeed: input.options.omitSummarySeed,
      seed: input.options.seed,
      summaryMaxOutputTokens: input.options.summaryMaxOutputTokens,
      trials: input.options.trials,
    },
    protocol: protocolFor(input.options.omitSummarySeed),
    provider: providerCopy(input.provider),
    schemaVersion: 1,
    seedCapability: capabilityCopy(input.seedCapability),
  };
}

export function createPreflightReport(
  provider: ProviderCampaignIdentity,
  seedCapability: SeedCapabilityReport
): PreflightReport {
  return {
    provider: providerCopy(provider),
    schemaVersion: 1,
    seedCapability: capabilityCopy(seedCapability),
    status: "passed",
  };
}

export function parseCampaignManifest(value: unknown): CampaignManifest {
  try {
    if (!isRecord(value) || value.schemaVersion !== 1) {
      return invalidManifest();
    }
    if (
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return invalidManifest();
    }
    const mode =
      value.mode === "benchmark" || value.mode === "preflight"
        ? value.mode
        : invalidManifest();
    const options = parseOptions(value.options);
    const provider = parseProvider(value.provider);
    const seedCapability = parseCapability(value.seedCapability);
    const manifest = createCampaignManifest({
      createdAt: value.createdAt,
      mode,
      options,
      provider,
      seedCapability,
    });
    if (!sameProtocol(value.protocol, manifest.protocol)) {
      return invalidManifest();
    }
    return manifest;
  } catch {
    return invalidManifest();
  }
}

function parseOptions(value: unknown): CampaignBenchmarkOptions {
  if (!isRecord(value)) {
    return invalidManifest();
  }
  const options = {
    fixtures: positiveInteger(value.fixtures),
    maxAttempts: positiveInteger(value.maxAttempts),
    omitSummarySeed:
      typeof value.omitSummarySeed === "boolean"
        ? value.omitSummarySeed
        : invalidManifest(),
    seed: safeString(value.seed),
    summaryMaxOutputTokens: positiveInteger(value.summaryMaxOutputTokens),
    trials: positiveInteger(value.trials),
  };
  return options;
}

function providerCopy(
  provider: ProviderCampaignIdentity
): ProviderCampaignIdentity {
  return sanitizeProviderCampaignIdentity({
    baseUrl: provider.baseOrigin,
    label: provider.label,
    modelId: provider.modelId,
  });
}

function parseProvider(value: unknown): ProviderCampaignIdentity {
  if (!isRecord(value)) {
    return invalidManifest();
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
    return invalidManifest();
  }
  return provider;
}

function parseCapability(value: unknown): SeedCapabilityReport {
  if (!isRecord(value)) {
    return invalidManifest();
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
  return invalidManifest();
}

function capabilityCopy(value: SeedCapabilityReport): SeedCapabilityReport {
  return value.capability === "supported"
    ? { capability: "supported", status: "seeded-probe-succeeded" }
    : {
        capability: "unsupported",
        status: "seeded-probe-rejected-seedless-probe-succeeded",
      };
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
  if (!isRecord(value)) {
    return false;
  }
  return (Object.keys(expected) as (keyof CampaignProtocol)[]).every(
    (key) => value[key] === expected[key]
  );
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : invalidManifest();
}

function safeString(value: unknown): string {
  return typeof value === "string" &&
    value.length > 0 &&
    !hasControlCharacters(value)
    ? value
    : invalidManifest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidManifest(): never {
  throw new CampaignValidationError("campaign-manifest-invalid");
}
