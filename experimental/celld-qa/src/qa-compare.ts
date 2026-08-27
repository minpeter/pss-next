import { readFile } from "node:fs/promises";

interface Report {
  readonly celldCpuSystemTicks: number;
  readonly celldCpuUserTicks: number;
  readonly cpuSystemUs: number;
  readonly elapsedMs: number;
  readonly errors: number;
  readonly maxRssBytes: number;
  readonly retainedResponseBytes: number;
  readonly retainedResponseSlots: number;
  readonly runnerCpuUserUs: number;
}

interface CompareOptions {
  readonly baseline: string;
  readonly candidate: string;
}

export async function compareReports({
  baseline,
  candidate,
}: CompareOptions): Promise<{
  readonly passed: boolean;
  readonly ratio: number;
}> {
  const base = parseReport(await readFile(baseline, "utf8"));
  const next = parseReport(await readFile(candidate, "utf8"));
  const ratio = next.elapsedMs / base.elapsedMs - 1;
  const baseSlots = base.retainedResponseSlots;
  const nextSlots = next.retainedResponseSlots;
  const baseBytes = base.retainedResponseBytes;
  const nextBytes = next.retainedResponseBytes;
  return {
    passed:
      base.errors === 0 &&
      next.errors === 0 &&
      Number.isFinite(ratio) &&
      nextSlots < baseSlots &&
      nextBytes < baseBytes,
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
    typeof value.runnerCpuUserUs !== "number" ||
    !("retainedResponseBytes" in value) ||
    typeof value.retainedResponseBytes !== "number" ||
    !("retainedResponseSlots" in value) ||
    typeof value.retainedResponseSlots !== "number"
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
    retainedResponseBytes: value.retainedResponseBytes,
    retainedResponseSlots: value.retainedResponseSlots,
    runnerCpuUserUs: value.runnerCpuUserUs,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [baseline, candidate] = args[0] === "--" ? args.slice(1) : args;
  if (baseline === undefined || candidate === undefined) {
    throw new Error("Usage: qa:compare <baseline.json> <candidate.json>");
  }
  const result = await compareReports({
    baseline,
    candidate,
  });
  console.log(JSON.stringify(result));
  if (!result.passed) {
    process.exitCode = 1;
  }
}
