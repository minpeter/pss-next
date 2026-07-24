import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CampaignBenchmarkOptions,
  createCampaignManifest,
} from "./campaign-manifest";
import { getCompactionPromptProfile } from "./prompt-profiles";
import { sanitizeProviderCampaignIdentity } from "./provider-campaign";
import type { PromptProfileIdentity } from "./report";
import type { SeedCapabilityReport } from "./seed-preflight";
import { summary } from "./stability-gates.test-support";

const defaultOptions: CampaignBenchmarkOptions = {
  fixtures: 12,
  maxAttempts: 3,
  omitSummarySeed: false,
  providerTimeoutMs: 120_000,
  seed: "orchestration-test",
  summaryMaxOutputTokens: 1024,
  trials: 3,
};

const supported: SeedCapabilityReport = {
  capability: "supported",
  status: "seeded-probe-succeeded",
};

export interface CampaignRunFixtureOptions {
  readonly baseUrl?: string;
  readonly label?: string;
  readonly manifestExtra?: Readonly<Record<string, unknown>>;
  readonly modelId?: string;
  readonly profileId?: string;
  readonly seedCapability?: SeedCapabilityReport;
  readonly summaryExtra?: Readonly<Record<string, unknown>>;
  readonly trialExtra?: Readonly<Record<string, unknown>>;
  readonly trialProfile?: PromptProfileIdentity;
}

export async function writeCampaignRunFixture(
  options: CampaignRunFixtureOptions = {}
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "compaction-campaign-run-"));
  const profile = profileIdentity(options.profileId ?? "senpi-maximal");
  const provider = sanitizeProviderCampaignIdentity({
    baseUrl: options.baseUrl ?? "https://one.example/v1",
    label: options.label ?? "gateway-one",
    modelId: options.modelId ?? "model-a",
  });
  const seedCapability = options.seedCapability ?? supported;
  const benchmarkOptions = {
    ...defaultOptions,
    omitSummarySeed: seedCapability.capability === "unsupported",
  };
  const manifestInput = {
    createdAt: "2026-07-24T00:00:00.000Z",
    mode: "benchmark" as const,
    options: benchmarkOptions,
    profile,
    provider,
    seedCapability,
  };
  const manifest = createCampaignManifest(manifestInput);
  const report = summary();

  await Promise.all([
    writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({ ...manifest, ...options.manifestExtra, profile })
    ),
    writeFile(
      join(directory, "summary.json"),
      JSON.stringify({ ...report, ...options.summaryExtra })
    ),
    writeFile(
      join(directory, "trials.jsonl"),
      `${JSON.stringify({
        profile: options.trialProfile ?? profile,
        status: "valid",
        ...options.trialExtra,
      })}\n`
    ),
  ]);

  return directory;
}

export async function writeBaselineSummary(): Promise<{
  readonly directory: string;
  readonly path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compaction-baseline-"));
  const path = join(directory, "summary.json");
  await writeFile(path, JSON.stringify(summary()));
  return { directory, path };
}

export function profileIdentity(id: string): PromptProfileIdentity {
  const profile = getCompactionPromptProfile(id);
  return { hash: profile.hash, id: profile.id };
}
