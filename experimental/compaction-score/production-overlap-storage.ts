import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./production-overlap-parse";
import { renderProductionOverlapReport } from "./production-overlap-report";
import type {
  ProductionOverlapAttempt,
  ProductionOverlapPair,
  ProductionOverlapReport,
} from "./production-overlap-types";
import {
  parseProductionOverlapAttempt,
  parseProductionOverlapPair,
} from "./production-overlap-validation";

export async function loadProductionOverlapResume(
  outputDirectory: string,
  identity: {
    readonly mode: ProductionOverlapReport["mode"];
    readonly model: string;
    readonly repetitions: number;
  }
): Promise<{
  readonly attempts: readonly ProductionOverlapAttempt[];
  readonly pairs: readonly ProductionOverlapPair[];
} | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(join(outputDirectory, "production-overlap.json"), "utf8")
    );
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== "production-overlap-v1" ||
    raw.mode !== identity.mode ||
    raw.model !== identity.model ||
    typeof raw.repetitions !== "number" ||
    raw.repetitions > identity.repetitions ||
    !Array.isArray(raw.attempts) ||
    !Array.isArray(raw.pairs)
  ) {
    throw new TypeError("Existing production overlap identity mismatch.");
  }
  const attempts = raw.attempts.map(parseProductionOverlapAttempt);
  const pairs = raw.pairs.map(parseProductionOverlapPair);
  assertUnique(
    attempts.map((attempt) => `${attempt.scenario}:${attempt.repetition}`),
    "attempt"
  );
  assertUnique(
    pairs.map((pair) => `${pair.scenario}:${pair.repetition}`),
    "pair"
  );
  return { attempts, pairs };
}

export async function writeProductionOverlapReport(
  outputDirectory: string,
  report: ProductionOverlapReport
): Promise<void> {
  await Promise.all([
    atomicWrite(
      join(outputDirectory, "production-overlap.json"),
      `${JSON.stringify(report, null, 2)}\n`
    ),
    atomicWrite(
      join(outputDirectory, "production-overlap.md"),
      renderProductionOverlapReport(report)
    ),
  ]);
}

export async function writeProductionOverlapReceipt(
  outputDirectory: string,
  receipt: {
    readonly argv: readonly string[];
    readonly completedAt: string | null;
    readonly error: string | null;
    readonly startedAt: string;
    readonly status: "completed" | "failed" | "running";
  }
): Promise<void> {
  await atomicWrite(
    join(outputDirectory, "production-overlap-command.json"),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`Production overlap ${label} cells are duplicated.`);
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
