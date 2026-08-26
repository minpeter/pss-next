import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateDeadlineSweepInputEvidence } from "./deadline-sweep-receipt";
import { validateDeadlineSweepArtifact } from "./five-track-validation";

async function main(): Promise<void> {
  const input = parseInput(process.argv.slice(2));
  const report: unknown = JSON.parse(await readFile(resolve(input), "utf8"));
  validateDeadlineSweepArtifact(report);
  await validateDeadlineSweepInputEvidence(report);
  console.log(JSON.stringify({ valid: true }));
}

function parseInput(args: readonly string[]): string {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    console.log("Usage: deadline-sweep-validate --input deadline-sweep.json");
    process.exit(0);
  }
  if (normalized.length !== 2 || normalized[0] !== "--input") {
    throw new TypeError("Deadline sweep validator requires --input.");
  }
  const input = normalized[1];
  if (input === undefined || input.length === 0) {
    throw new TypeError("Deadline sweep validator requires --input.");
  }
  return input;
}

await main();
