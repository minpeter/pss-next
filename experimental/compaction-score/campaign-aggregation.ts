import { pathToFileURL } from "node:url";
import {
  loadCampaignRunDirectory,
  loadSummaryArtifact,
  type RunArtifactValidationCode,
  RunArtifactValidationError,
} from "./campaign-run-artifact";
import {
  type CampaignValidationCode,
  CampaignValidationError,
  validateOptionBCampaigns,
} from "./provider-campaign";
import { evaluateStabilityComparison } from "./stability-gates";

const HELP = `Usage: pnpm campaigns -- --baseline SUMMARY_JSON RUN_DIR RUN_DIR RUN_DIR

Aggregate exactly three independently produced campaign run directories.
The CLI reads sanitized artifacts only and never starts providers or stores credentials.`;

export type CampaignAggregationValidationCode = "CAMPAIGN_PROFILE_MISMATCH";

type CampaignAggregationFailureCode =
  | CampaignAggregationValidationCode
  | CampaignValidationCode
  | RunArtifactValidationCode;

export class CampaignAggregationValidationError extends Error {
  readonly code: CampaignAggregationValidationCode;
  readonly name = "CampaignAggregationValidationError";

  constructor(code: CampaignAggregationValidationCode) {
    super(code);
    this.code = code;
  }
}

interface CliIo {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

const processIo: CliIo = {
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
};

export async function runCampaignAggregationCli(
  args: readonly string[],
  io: CliIo = processIo
): Promise<number> {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 1 && normalized[0] === "--help") {
    io.stdout(`${HELP}\n`);
    return 0;
  }
  const options = parseOptions(normalized);
  if (!options) {
    io.stderr(`${HELP}\n`);
    return 2;
  }

  try {
    const [baseline, ...runs] = await Promise.all([
      loadSummaryArtifact(options.baselinePath),
      ...options.directories.map((directory) =>
        loadCampaignRunDirectory(directory)
      ),
    ]);
    validateOptionBCampaigns(runs.map(({ manifest }) => manifest.provider));
    const profile = runs[0]?.profile;
    if (
      !profile ||
      runs.some(
        (run) =>
          run.profile.id !== profile.id || run.profile.hash !== profile.hash
      )
    ) {
      throw new CampaignAggregationValidationError("CAMPAIGN_PROFILE_MISMATCH");
    }

    const campaigns = runs.map((run) => ({
      decision: publicDecision(
        evaluateStabilityComparison(baseline, run.summary)
      ),
      provider: run.manifest.provider,
      seedCapability: run.manifest.seedCapability,
    }));
    const failures = campaigns.flatMap(({ decision }, campaignIndex) =>
      decision.passed
        ? []
        : [
            {
              campaign: campaignIndex + 1,
              code: "CAMPAIGN_GATE_FAILED" as const,
              gateCodes: decision.failureCodes,
            },
          ]
    );
    const decision = failures.length === 0 ? "promote" : "no-promotion";
    io.stdout(
      `${JSON.stringify(
        {
          campaigns,
          decision,
          failures,
          profile,
          schemaVersion: 1,
        },
        null,
        2
      )}\n`
    );
    return decision === "promote" ? 0 : 1;
  } catch (error) {
    if (
      error instanceof CampaignAggregationValidationError ||
      error instanceof CampaignValidationError ||
      error instanceof RunArtifactValidationError
    ) {
      writeFailure(io, error.code);
      return 1;
    }
    throw error;
  }
}

function parseOptions(args: readonly string[]): {
  readonly baselinePath: string;
  readonly directories: readonly [string, string, string];
} | null {
  if (args[0] !== "--baseline" || args.length !== 5) {
    return null;
  }
  const baselinePath = args[1];
  const first = args[2];
  const second = args[3];
  const third = args[4];
  if (!(baselinePath && first && second && third)) {
    return null;
  }
  return { baselinePath, directories: [first, second, third] };
}

function publicDecision(
  decision: ReturnType<typeof evaluateStabilityComparison>
) {
  return {
    failureCodes: decision.failures.map(({ code }) => code),
    passed: decision.passed,
  };
}

function writeFailure(io: CliIo, code: CampaignAggregationFailureCode): void {
  io.stdout(
    `${JSON.stringify(
      {
        campaigns: [],
        decision: "no-promotion",
        failures: [{ code }],
        profile: null,
        schemaVersion: 1,
      },
      null,
      2
    )}\n`
  );
}

const executable = process.argv[1];
if (executable && import.meta.url === pathToFileURL(executable).href) {
  process.exitCode = await runCampaignAggregationCli(process.argv.slice(2));
}
