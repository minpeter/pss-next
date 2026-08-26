import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseComparePiReport, parseComparisonRows } from "./compare-pi-parse";
import type {
  ComparePiIdentity,
  ComparePiReport,
  ComparisonRow,
} from "./compare-pi-types";

export type { ComparePiIdentity } from "./compare-pi-types";

export async function loadComparePiRows(
  outputDirectory: string,
  identity: ComparePiIdentity
): Promise<readonly ComparisonRow[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(join(outputDirectory, "comparison.partial.json"), "utf8")
    );
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== "compare-pi-partial-v3" ||
    raw.model !== identity.model ||
    raw.repetitions !== identity.repetitions ||
    raw.summaryMaxOutputTokens !== identity.summaryMaxOutputTokens
  ) {
    throw new TypeError("Existing compare-pi partial identity mismatch.");
  }
  return parseComparisonRows(raw.rows, identity.summaryMaxOutputTokens);
}

export async function writeComparePiRows(
  outputDirectory: string,
  identity: ComparePiIdentity,
  rows: readonly ComparisonRow[]
): Promise<void> {
  const parsedRows = parseComparisonRows(rows, identity.summaryMaxOutputTokens);
  await atomicWrite(
    join(outputDirectory, "comparison.partial.json"),
    `${JSON.stringify(
      {
        ...identity,
        rows: parsedRows,
        schemaVersion: "compare-pi-partial-v3",
      },
      null,
      2
    )}\n`
  );
}

export async function writeComparePiReport(
  outputDirectory: string,
  report: ComparePiReport
): Promise<void> {
  parseComparePiReport(report);
  await atomicWrite(
    join(outputDirectory, "comparison.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
