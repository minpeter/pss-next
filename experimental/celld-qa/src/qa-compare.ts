import { readFile } from "node:fs/promises";

interface Report {
  readonly elapsedMs: number;
  readonly errors: number;
  readonly retainedResponseSlots?: number;
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
  const baseSlots = base.retainedResponseSlots ?? 100;
  const nextSlots = next.retainedResponseSlots ?? 100;
  return {
    passed:
      base.errors === 0 &&
      next.errors === 0 &&
      Number.isFinite(ratio) &&
      ratio <= maxElapsedRegression &&
      nextSlots < baseSlots,
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
    typeof value.errors !== "number"
  ) {
    throw new Error("invalid load report");
  }
  return {
    elapsedMs: value.elapsedMs,
    errors: value.errors,
    ...("retainedResponseSlots" in value &&
    typeof value.retainedResponseSlots === "number"
      ? { retainedResponseSlots: value.retainedResponseSlots }
      : {}),
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
