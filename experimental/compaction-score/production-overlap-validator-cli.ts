import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateProductionOverlapReceipt } from "./production-overlap-receipt";
import { validateProductionOverlapArtifact } from "./production-overlap-validation";

async function main(): Promise<void> {
  const input = parseInput(process.argv.slice(2));
  const artifact: unknown = JSON.parse(await readFile(resolve(input), "utf8"));
  const { evidence, ...validation } =
    validateProductionOverlapArtifact(artifact);
  const receipt = await validateProductionOverlapReceipt(
    resolve(input),
    evidence
  );
  console.log(JSON.stringify({ ...validation, receiptSha256: receipt.sha256 }));
}

function parseInput(args: readonly string[]): string {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    console.log(
      "Usage: production-overlap-validate --input production-overlap.json"
    );
    process.exit(0);
  }
  if (normalized.length !== 2 || normalized[0] !== "--input") {
    throw new TypeError("Production overlap validator requires --input.");
  }
  const input = normalized[1];
  if (input === undefined || input.length === 0) {
    throw new TypeError("Production overlap validator requires --input.");
  }
  return input;
}

await main();
