import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CampaignManifest,
  parseCampaignManifest,
} from "./campaign-manifest";
import {
  getCompactionPromptProfile,
  type SenpiRuleId,
} from "./prompt-profiles";
import type { PromptProfileIdentity } from "./report";

export type RunArtifactValidationCode =
  | "PROFILE_HASH_MISMATCH"
  | "PROFILE_UNKNOWN"
  | "RUN_MANIFEST_INVALID"
  | "RUN_MANIFEST_NOT_BENCHMARK"
  | "RUN_MANIFEST_READ_FAILED"
  | "RUN_SUMMARY_INVALID"
  | "RUN_SUMMARY_READ_FAILED"
  | "RUN_TRIALS_EMPTY"
  | "RUN_TRIALS_INVALID"
  | "RUN_TRIALS_READ_FAILED"
  | "TRIAL_PROFILE_MISMATCH"
  | "TRIAL_PROFILE_MISSING";

export class RunArtifactValidationError extends Error {
  readonly code: RunArtifactValidationCode;
  readonly name = "RunArtifactValidationError";

  constructor(code: RunArtifactValidationCode) {
    super(code);
    this.code = code;
  }
}

export interface CampaignRunArtifact {
  readonly manifest: CampaignManifest;
  readonly profile: PromptProfileIdentity;
  readonly rules: readonly SenpiRuleId[];
  readonly summary: unknown;
}

export async function loadCampaignRunDirectory(
  directory: string
): Promise<CampaignRunArtifact> {
  const [manifestSource, summarySource, trialsSource] = await Promise.all([
    readArtifact(join(directory, "manifest.json"), "RUN_MANIFEST_READ_FAILED"),
    readArtifact(join(directory, "summary.json"), "RUN_SUMMARY_READ_FAILED"),
    readArtifact(join(directory, "trials.jsonl"), "RUN_TRIALS_READ_FAILED"),
  ]);
  const manifest = parseManifest(manifestSource);
  if (manifest.mode !== "benchmark") {
    throw new RunArtifactValidationError("RUN_MANIFEST_NOT_BENCHMARK");
  }
  const registered = resolveRegisteredProfile(manifest.profile);
  parseTrialAttribution(trialsSource, manifest.profile);

  return {
    manifest,
    profile: { hash: registered.hash, id: registered.id },
    rules: registered.rules,
    summary: parseJson(summarySource, "RUN_SUMMARY_INVALID"),
  };
}

export async function loadSummaryArtifact(path: string): Promise<unknown> {
  const source = await readArtifact(path, "RUN_SUMMARY_READ_FAILED");
  return parseJson(source, "RUN_SUMMARY_INVALID");
}

export function resolveRegisteredProfile(identity: PromptProfileIdentity) {
  let registered: ReturnType<typeof getCompactionPromptProfile>;
  try {
    registered = getCompactionPromptProfile(identity.id);
  } catch {
    throw new RunArtifactValidationError("PROFILE_UNKNOWN");
  }
  if (registered.hash !== identity.hash) {
    throw new RunArtifactValidationError("PROFILE_HASH_MISMATCH");
  }
  return registered;
}

async function readArtifact(
  path: string,
  code: Extract<RunArtifactValidationCode, `${string}_READ_FAILED`>
): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new RunArtifactValidationError(code);
  }
}

function parseManifest(source: string): CampaignManifest {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new RunArtifactValidationError("RUN_MANIFEST_INVALID");
  }
  try {
    return parseCampaignManifest(value);
  } catch {
    throw new RunArtifactValidationError("RUN_MANIFEST_INVALID");
  }
}

function parseJson(source: string, code: RunArtifactValidationCode): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new RunArtifactValidationError(code);
  }
}

function parseTrialAttribution(
  source: string,
  expected: PromptProfileIdentity
): void {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new RunArtifactValidationError("RUN_TRIALS_EMPTY");
  }
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      throw new RunArtifactValidationError("RUN_TRIALS_INVALID");
    }
    if (!(isRecord(record) && isRecord(record.profile))) {
      throw new RunArtifactValidationError("TRIAL_PROFILE_MISSING");
    }
    if (
      record.profile.id !== expected.id ||
      record.profile.hash !== expected.hash
    ) {
      throw new RunArtifactValidationError("TRIAL_PROFILE_MISMATCH");
    }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
