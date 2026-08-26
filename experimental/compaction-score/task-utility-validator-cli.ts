import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateTaskUtilityArtifact } from "./task-utility-artifact-validation";
import { validateTaskUtilityEvidence } from "./task-utility-evidence-validation";

async function main(): Promise<void> {
  const input = parseInput(process.argv.slice(2));
  const artifact: unknown = JSON.parse(await readFile(resolve(input), "utf8"));
  const result = validateTaskUtilityArtifact(artifact);
  await validateTaskUtilityEvidence(artifact, {
    artifactPath: resolve(input),
    requireCompletedReceipt: true,
  });
  console.log(JSON.stringify(result));
}

function parseInput(args: readonly string[]): string {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    console.log("Usage: task-utility-validate --input task-utility.json");
    process.exit(0);
  }
  if (normalized.length !== 2 || normalized[0] !== "--input") {
    throw new TypeError("Task utility validator requires --input.");
  }
  const input = normalized[1];
  if (input === undefined || input.length === 0) {
    throw new TypeError("Task utility validator requires --input.");
  }
  return input;
}

await main();
