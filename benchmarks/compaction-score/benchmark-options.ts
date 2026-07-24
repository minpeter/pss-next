import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BenchmarkOptions {
  readonly fixtures: number;
  readonly maxAttempts: number;
  readonly omitSummarySeed: boolean;
  readonly outputDir: string;
  readonly preflightOnly: boolean;
  readonly profileId: string;
  readonly providerLabel: string;
  readonly providerTimeoutMs: number;
  readonly scenario?: string;
  readonly seed: string;
  readonly summaryMaxOutputTokens: number;
  readonly trials: number;
}

export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export const BENCHMARK_HELP = `Usage: pnpm score -- [options]

Options:
  --fixtures N                  Independent fixture seeds (default: 3)
  --trials N                    Valid repetitions per fixture (default: 2)
  --max-attempts N              Attempts per fixture/repetition (default: 3)
  --seed STRING                 Base fixture seed
  --provider-label STRING       Sanitized campaign label (default: custom)
  --provider-timeout-ms N       Per-call provider timeout (default: 120000)
  --profile ID                  Compaction prompt profile (default: production)
  --scenario ID                 Run one named benchmark scenario
  --omit-summary-seed           Omit seed only after capability preflight
  --preflight-only              Write sanitized reports without fixtures
  --summary-max-output-tokens N Hard summary output cap (default: 1024)
  --output PATH                 Report directory
  --help                        Show this help`;

export function parseBenchmarkOptions(
  args: readonly string[],
  now = new Date()
): BenchmarkOptions {
  const timestamp = now.toISOString().replaceAll(":", "-");
  const read = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    if (index === -1) {
      return fallback;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(`${name} requires a value.`);
    }
    return value;
  };

  return {
    fixtures: positiveInteger(read("--fixtures", "3"), "--fixtures"),
    maxAttempts: positiveInteger(read("--max-attempts", "3"), "--max-attempts"),
    omitSummarySeed: args.includes("--omit-summary-seed"),
    outputDir: read(
      "--output",
      join(tmpdir(), `compaction-score-${timestamp}`)
    ),
    preflightOnly: args.includes("--preflight-only"),
    profileId: read("--profile", "production"),
    providerLabel: read("--provider-label", "custom"),
    providerTimeoutMs: positiveInteger(
      read("--provider-timeout-ms", String(DEFAULT_PROVIDER_TIMEOUT_MS)),
      "--provider-timeout-ms"
    ),
    ...(args.includes("--scenario")
      ? { scenario: read("--scenario", "") }
      : {}),
    seed: read("--seed", "compaction-score-v2"),
    summaryMaxOutputTokens: positiveInteger(
      read("--summary-max-output-tokens", "1024"),
      "--summary-max-output-tokens"
    ),
    trials: positiveInteger(read("--trials", "2"), "--trials"),
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!(Number.isInteger(parsed) && parsed > 0)) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return parsed;
}
