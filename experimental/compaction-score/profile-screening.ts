import { pathToFileURL } from "node:url";
import {
  type CampaignRunArtifact,
  loadCampaignRunDirectory,
  type RunArtifactValidationCode,
  RunArtifactValidationError,
} from "./campaign-run-artifact";
import {
  createScreeningEntry,
  parseScreeningOptions,
  publicScreeningEntry,
  type ScreeningValidationCode,
  ScreeningValidationError,
  selectScreeningWinner,
} from "./profile-screening-domain";

const HELP = `Usage: pnpm screen -- --baseline RUN_DIR --profile PROFILE_ID=RUN_DIR [--profile PROFILE_ID=RUN_DIR ...]

Screen independently produced profile run directories against a production run.
The CLI reads sanitized artifacts only and never starts providers or stores credentials.`;

interface CliIo {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

interface ScreeningFailure {
  readonly code: RunArtifactValidationCode | ScreeningValidationCode;
}

const processIo: CliIo = {
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
};

export async function runProfileScreeningCli(
  args: readonly string[],
  io: CliIo = processIo
): Promise<number> {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 1 && normalized[0] === "--help") {
    io.stdout(`${HELP}\n`);
    return 0;
  }

  let options: ReturnType<typeof parseScreeningOptions>;
  try {
    options = parseScreeningOptions(normalized);
  } catch (error) {
    if (isValidationError(error)) {
      writeFailure(io, { code: error.code });
      return 1;
    }
    io.stderr(`${HELP}\n`);
    return 2;
  }

  try {
    const [baseline, ...candidates] = await Promise.all([
      loadCampaignRunDirectory(options.baselineDirectory),
      ...options.profiles.map(({ directory }) =>
        loadCampaignRunDirectory(directory)
      ),
    ]);
    if (baseline.profile.id !== "production") {
      throw new ScreeningValidationError("SCREEN_BASELINE_PROFILE_INVALID");
    }

    const entries = options.profiles.map((spec, index) =>
      createScreeningEntry(
        baseline,
        candidates[index] as CampaignRunArtifact,
        spec.id
      )
    );
    const winner = selectScreeningWinner(entries);
    const output = {
      baseline: baseline.profile,
      profiles: entries.map(publicScreeningEntry),
      schemaVersion: 1,
      screened: true,
      winner,
    } as const;
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return winner === null ? 1 : 0;
  } catch (error) {
    if (isValidationError(error)) {
      writeFailure(io, { code: error.code });
      return 1;
    }
    throw error;
  }
}

function isValidationError(
  error: unknown
): error is RunArtifactValidationError | ScreeningValidationError {
  return (
    error instanceof RunArtifactValidationError ||
    error instanceof ScreeningValidationError
  );
}

function writeFailure(io: CliIo, failure: ScreeningFailure): void {
  io.stdout(
    `${JSON.stringify(
      {
        failures: [failure],
        schemaVersion: 1,
        screened: false,
        winner: null,
      },
      null,
      2
    )}\n`
  );
}

const executable = process.argv[1];
if (executable && import.meta.url === pathToFileURL(executable).href) {
  process.exitCode = await runProfileScreeningCli(process.argv.slice(2));
}
