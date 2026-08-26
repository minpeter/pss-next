import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDeadlineSweepReport } from "./deadline-sweep-analysis";
import { validateDeadlineSweepReceipt } from "./deadline-sweep-receipt";
import { renderDeadlineSweepReport } from "./deadline-sweep-report";
import type {
  DeadlineInputEvidence,
  DeadlineSweepReport,
} from "./deadline-sweep-types";
import {
  parseDeadlineArm,
  parseHistoricalEvidence,
} from "./deadline-sweep-validation";
import { formatTerminalReportLocation } from "./terminal-text";

interface CliOptions {
  readonly historicalPath: string | null;
  readonly inputPaths: readonly string[];
  readonly outputDirectory: string;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const entries = await Promise.all(
    options.inputPaths.map(async (path) => {
      const source = resolve(path);
      const contents = await readFile(source, "utf8");
      const raw: unknown = JSON.parse(contents);
      const arm = parseDeadlineArm(raw, source);
      let receiptSha256: string | null = null;
      const exactReceipt = arm.mode === "live" && arm.deadlineMs >= 10_000;
      if (exactReceipt) {
        receiptSha256 = (
          await validateDeadlineSweepReceipt(source, arm.deadlineMs)
        ).sha256;
      }
      const evidence: DeadlineInputEvidence = {
        artifactSha256: digest(contents),
        receiptPolicy: exactReceipt
          ? "exact-live-command"
          : "legacy-unverified",
        receiptSha256,
        source,
      };
      return { arm, evidence };
    })
  );
  const historical =
    options.historicalPath === null
      ? null
      : await readHistorical(options.historicalPath);
  const report: DeadlineSweepReport = {
    ...createDeadlineSweepReport(
      entries.map(({ arm }) => arm),
      historical
    ),
    inputEvidence: Object.fromEntries(
      entries.map(({ arm, evidence }) => [String(arm.deadlineMs), evidence])
    ),
  };
  await mkdir(options.outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(options.outputDirectory, "deadline-sweep.json"),
      `${JSON.stringify(report, null, 2)}\n`
    ),
    writeFile(
      join(options.outputDirectory, "deadline-sweep.md"),
      renderDeadlineSweepReport(report)
    ),
  ]);
  console.log(
    `deadline-sweep: ${report.deadlinesMs.join("/")}ms, ${Object.keys(report.scenarios).length} scenarios`
  );
  console.log(formatTerminalReportLocation(options.outputDirectory));
}

async function readHistorical(path: string) {
  const contents = await readFile(resolve(path), "utf8");
  const raw: unknown = JSON.parse(contents);
  return parseHistoricalEvidence(
    raw,
    path,
    createHash("sha256").update(contents).digest("hex")
  );
}

function digest(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function parseOptions(args: readonly string[]): CliOptions {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    printHelpAndExit();
  }
  let historicalPath: string | null = null;
  let inputPaths: readonly string[] = [];
  let outputDirectory = "";
  for (let index = 0; index < normalized.length; index += 2) {
    const flag = normalized[index];
    const value = normalized[index + 1];
    if (flag === "--inputs" && value) {
      inputPaths = value.split(",").filter((path) => path.length > 0);
    } else if (flag === "--historical" && value) {
      historicalPath = value;
    } else if (flag === "--output" && value) {
      outputDirectory = value;
    } else {
      throw new TypeError(`Invalid deadline-sweep option: ${flag ?? ""}`);
    }
  }
  if (inputPaths.length !== 4 || outputDirectory.length === 0) {
    throw new TypeError(
      "Deadline sweep requires four inputs and an output directory."
    );
  }
  return { historicalPath, inputPaths, outputDirectory };
}

function printHelpAndExit(): never {
  console.log(
    "Usage: deadline-sweep --inputs 5000.json,10000.json,15000.json,20000.json [--historical comparison.json] --output DIR"
  );
  process.exit(0);
}

try {
  await main();
} catch {
  process.stderr.write("deadline-sweep-failure\n");
  process.exitCode = 1;
}
