import { readFile } from "node:fs/promises";

interface Report {
  readonly celldCpuSystemTicks: number;
  readonly celldCpuUserTicks: number;
  readonly cpuSystemUs: number;
  readonly elapsedMs: number;
  readonly errors: number;
  readonly maxRssBytes: number;
  readonly retainedResponseSlots: number;
  readonly runnerCpuUserUs: number;
}

interface CompareOptions {
  readonly baseline: string;
  readonly candidate: string;
  readonly maxElapsedRegression: number;
}

export async function compareReports({
  baseline,
  candidate,
  maxElapsedRegression,
}: CompareOptions): Promise<{
  readonly passed: boolean;
  readonly ratio: number;
}> {
  const base = parseReport(await readFile(baseline, "utf8"));
  const next = parseReport(await readFile(candidate, "utf8"));
  const ratio = next.elapsedMs / base.elapsedMs - 1;
  const baseSlots = base.retainedResponseSlots;
  const nextSlots = next.retainedResponseSlots;
  return {
    passed:
      base.errors === 0 &&
      next.errors === 0 &&
      Number.isFinite(ratio) &&
      ratio <= maxElapsedRegression &&
      nextSlots < baseSlots &&
      next.maxRssBytes <= base.maxRssBytes * 1.05 &&
      next.celldCpuUserTicks <= base.celldCpuUserTicks * 1.05,
    ratio,
  };
}

function parseReport(text: string): Report {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("elapsedMs" in value) ||
    typeof value.elapsedMs !== "number" ||
    !("errors" in value) ||
    typeof value.errors !== "number" ||
    !("celldCpuSystemTicks" in value) ||
    typeof value.celldCpuSystemTicks !== "number" ||
    !("celldCpuUserTicks" in value) ||
    typeof value.celldCpuUserTicks !== "number" ||
    !("cpuSystemUs" in value) ||
    typeof value.cpuSystemUs !== "number" ||
    !("maxRssBytes" in value) ||
    typeof value.maxRssBytes !== "number" ||
    !("runnerCpuUserUs" in value) ||
    typeof value.runnerCpuUserUs !== "number"
  ) {
    throw new Error("invalid load report");
  }
  return {
    cpuSystemUs: value.cpuSystemUs,
    elapsedMs: value.elapsedMs,
    errors: value.errors,
    celldCpuSystemTicks: value.celldCpuSystemTicks,
    celldCpuUserTicks: value.celldCpuUserTicks,
    maxRssBytes: value.maxRssBytes,
    ...("retainedResponseSlots" in value &&
    typeof value.retainedResponseSlots === "number"
      ? { retainedResponseSlots: value.retainedResponseSlots }
      : { retainedResponseSlots: 0 }),
    runnerCpuUserUs: value.runnerCpuUserUs,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [baseline, candidate, maxRegression] =
    args[0] === "--" ? args.slice(1) : args;
  if (baseline === undefined || candidate === undefined) {
    throw new Error("Usage: qa:compare <baseline.json> <candidate.json>");
  }
  const result = await compareReports({
    baseline,
    candidate,
    maxElapsedRegression: Number(maxRegression ?? "0.05"),
  });
  console.log(JSON.stringify(result));
  if (!result.passed) {
    process.exitCode = 1;
  }
}
