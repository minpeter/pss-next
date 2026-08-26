import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { object, positiveInteger } from "./quality-sweep-parse";
import { validateQualitySweepReceipt } from "./quality-sweep-receipt";
import { validateQualitySweepArtifact } from "./quality-sweep-validation";

async function main(): Promise<void> {
  const input = parseInput(process.argv.slice(2));
  const artifact: unknown = JSON.parse(await readFile(resolve(input), "utf8"));
  const validation = validateQualitySweepArtifact(artifact);
  const report = object(artifact, "quality sweep");
  if (report.mode !== "deterministic" && report.mode !== "live") {
    throw new TypeError("Invalid quality sweep mode.");
  }
  const receipt = await validateQualitySweepReceipt(resolve(input), {
    mode: report.mode,
    repetitions: positiveInteger(report.repetitions, "repetitions"),
  });
  console.log(JSON.stringify({ ...validation, receiptSha256: receipt.sha256 }));
}

function parseInput(args: readonly string[]): string {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    console.log("Usage: quality-sweep-validate --input quality-sweep.json");
    process.exit(0);
  }
  if (normalized.length !== 2 || normalized[0] !== "--input") {
    throw new TypeError("Quality sweep validator requires --input.");
  }
  const input = normalized[1];
  if (input === undefined || input.length === 0) {
    throw new TypeError("Quality sweep validator requires --input.");
  }
  return input;
}

await main();
