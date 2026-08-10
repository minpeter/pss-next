import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runComparisonReportCli } from "./comparison-report-cli";
import type { ReportRole } from "./stability-comparison";
import {
  evaluateStabilityComparison,
  reportJsonInvalidFailure,
  reportReadFailure,
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

interface UnloadedReport {
  readonly decision: StabilityGateDecision;
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
  const baseline = await loadReport(baselinePath, "baseline");
  if (!baseline.loaded) {
    writeDecision(io, baseline.decision);
    return 1;
  }
  const candidate = await loadReport(candidatePath, "candidate");
  if (!candidate.loaded) {
    writeDecision(io, candidate.decision);
    return 1;
  }

  const decision = evaluateStabilityComparison(baseline.value, candidate.value);
  writeDecision(io, decision);
  return decision.passed ? 0 : 1;
}

async function loadReport(
  path: string,
  report: ReportRole
): Promise<ReportLoad> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return failedLoad(reportReadFailure(report, path));
  }

  try {
    return { loaded: true, value: JSON.parse(source) as unknown };
  } catch {
    return failedLoad(reportJsonInvalidFailure(report, path));
  }
}

function failedLoad(
  failure: StabilityGateDecision["failures"][number]
): UnloadedReport {
  return {
    decision: { failures: [failure], passed: false },
    loaded: false,
  };
}

function writeDecision(io: ComparisonCliIo, decision: StabilityGateDecision) {
  io.stdout(`${JSON.stringify(decision, null, 2)}\n`);
}

const executable = process.argv[1];
if (executable && import.meta.url === pathToFileURL(executable).href) {
  process.exitCode = await runComparisonCli(process.argv.slice(2));
}
