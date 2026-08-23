import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runComparisonReportCli } from "./comparison-report-cli";
import {
  evaluateStabilityComparison,
  type StabilityGateDecision,
} from "./stability-gates";

const HELP = `Usage:
  pnpm compare -- BASELINE_SUMMARY CANDIDATE_SUMMARY
  pnpm compare -- --table COMPARISON_JSON

Compare frozen baseline and candidate compaction TrialSummary JSON files.
With --table, render a PSS vs pi-coding-agent Markdown report.`;

interface ComparisonCliIo {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

interface LoadedReport {
  readonly loaded: true;
  readonly value: unknown;
}

type ReportLoadFailure = "REPORT_JSON_INVALID" | "REPORT_READ_FAILED";

interface UnloadedReport {
  readonly failure: ReportLoadFailure;
  readonly loaded: false;
}

type ReportLoad = LoadedReport | UnloadedReport;

const processIo: ComparisonCliIo = {
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
};

export async function runComparisonCli(
  args: readonly string[],
  io: ComparisonCliIo = processIo
): Promise<number> {
  const positional = args[0] === "--" ? args.slice(1) : args;
  if (positional.length === 1 && positional[0] === "--help") {
    io.stdout(`${HELP}\n`);
    return 0;
  }
  if (positional[0] === "--table") {
    return runComparisonReportCli(positional.slice(1), io);
  }
  const baselinePath = positional[0];
  const candidatePath = positional[1];
  if (
    positional.length !== 2 ||
    baselinePath === undefined ||
    candidatePath === undefined
  ) {
    io.stderr(`${HELP}\n`);
    return 2;
  }
  const baseline = await loadReport(baselinePath);
  if (!baseline.loaded) {
    io.stderr(`${baseline.failure}\n`);
    return 1;
  }
  const candidate = await loadReport(candidatePath);
  if (!candidate.loaded) {
    io.stderr(`${candidate.failure}\n`);
    return 1;
  }

  const decision = evaluateStabilityComparison(baseline.value, candidate.value);
  writeDecision(io, decision);
  return decision.passed ? 0 : 1;
}

async function loadReport(path: string): Promise<ReportLoad> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return failedLoad("REPORT_READ_FAILED");
  }

  try {
    const value: unknown = JSON.parse(source);
    return { loaded: true, value };
  } catch {
    return failedLoad("REPORT_JSON_INVALID");
  }
}

function failedLoad(failure: ReportLoadFailure): UnloadedReport {
  return { failure, loaded: false };
}

function writeDecision(io: ComparisonCliIo, decision: StabilityGateDecision) {
  io.stdout(`${JSON.stringify(decision, null, 2)}\n`);
}

const executable = process.argv[1];
if (executable && import.meta.url === pathToFileURL(executable).href) {
  process.exitCode = await runComparisonCli(process.argv.slice(2));
}
