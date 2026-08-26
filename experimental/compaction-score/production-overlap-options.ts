import { parseCampaignRepetitions } from "./campaign-limits";
import type { ProductionOverlapReport } from "./production-overlap-types";

export const PRODUCTION_OVERLAP_COMPACTION_DEADLINE_MS = 60_000;

export interface ProductionOverlapCliOptions {
  readonly attemptTimeoutMs: number;
  readonly compactionDeadlineMs: number;
  readonly mode: ProductionOverlapReport["mode"];
  readonly outputDirectory: string;
  readonly repetitions: number;
}

export function parseProductionOverlapOptions(
  args: readonly string[]
): ProductionOverlapCliOptions {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    console.log(
      "Usage: production-overlap --mode deterministic|live --repetitions N [--attempt-timeout-ms N] --output DIR"
    );
    process.exit(0);
  }
  let mode: ProductionOverlapCliOptions["mode"] = "deterministic";
  let attemptTimeoutMs = 10 * 60 * 1000;
  let outputDirectory = `/tmp/production-overlap-${new Date().toISOString()}`;
  let repetitions = 10;
  for (let index = 0; index < normalized.length; index += 2) {
    const flag = normalized[index];
    const value = normalized[index + 1];
    if (flag === "--mode" && (value === "deterministic" || value === "live")) {
      mode = value;
    } else if (flag === "--output" && value) {
      outputDirectory = value;
    } else if (flag === "--repetitions") {
      repetitions = parseCampaignRepetitions(
        value,
        "Production overlap repetitions"
      );
    } else if (flag === "--attempt-timeout-ms" && isPositiveInteger(value)) {
      attemptTimeoutMs = Number(value);
    } else {
      throw new TypeError(`Invalid production-overlap option: ${flag ?? ""}`);
    }
  }
  return {
    attemptTimeoutMs,
    compactionDeadlineMs: PRODUCTION_OVERLAP_COMPACTION_DEADLINE_MS,
    mode,
    outputDirectory,
    repetitions,
  };
}

function isPositiveInteger(value: string | undefined): value is string {
  return (
    value !== undefined &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  );
}
