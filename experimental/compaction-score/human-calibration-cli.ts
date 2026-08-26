import { readFile } from "node:fs/promises";
import { exportHumanCalibration } from "./human-calibration-export";
import { validateHumanCalibrationReport } from "./human-calibration-report-validation";
import { scoreHumanCalibration } from "./human-calibration-score";
import {
  HUMAN_CALIBRATION_SECRET_ENV,
  resolveHumanCalibrationSecret,
} from "./human-calibration-sealing";
import { validateHumanCalibrationPacket } from "./human-calibration-validation";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 0 || normalized.includes("--help")) {
    printHelp();
    return;
  }
  const [command, ...rawOptionArgs] = normalized;
  const optionArgs =
    rawOptionArgs[0] === "--" ? rawOptionArgs.slice(1) : rawOptionArgs;
  const options = parseFlags(optionArgs);
  if (command === "export") {
    const result = await exportHumanCalibration({
      coordinatorSecret: requiredSecret(),
      inputPath: required(options, "--input"),
      outputDirectory: required(options, "--output"),
    });
    console.log(`packets=${result.packetCount} digest=${result.contentDigest}`);
    return;
  }
  if (command === "score") {
    process.env[HUMAN_CALIBRATION_SECRET_ENV] = requiredSecret();
    const result = await scoreHumanCalibration({
      labelsPath: required(options, "--labels"),
      outputDirectory: required(options, "--output"),
      packetDirectory: required(options, "--packet"),
    });
    console.log(
      `labels=${result.labelCount} exact=${result.humanFixtureAgreement.toFixed(3)}`
    );
    return;
  }
  if (command === "validate-export") {
    const result = await validateHumanCalibrationPacket(
      required(options, "--packet"),
      requiredSecret()
    );
    console.log(
      `packets=${result.packetCount} digest=${result.contentDigest} valid=true`
    );
    return;
  }
  if (command === "validate-score") {
    const input = required(options, "--input");
    const raw: unknown = JSON.parse(await readFile(input, "utf8"));
    validateHumanCalibrationReport(raw);
    console.log("human-calibration-score valid=true");
    return;
  }
  throw new TypeError(`Invalid human-calibration command: ${command ?? ""}`);
}

function parseFlags(args: readonly string[]): ReadonlyMap<string, string> {
  if (args.length % 2 !== 0) {
    throw new TypeError("Human calibration options require flag/value pairs.");
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined) {
      throw new TypeError(
        "Human calibration options require flag/value pairs."
      );
    }
    if (!flag.startsWith("--") || flag === "--secret" || options.has(flag)) {
      throw new TypeError(`Invalid human-calibration option: ${flag}`);
    }
    options.set(flag, value);
  }
  return options;
}

function requiredSecret(): string {
  return resolveHumanCalibrationSecret();
}

function required(options: ReadonlyMap<string, string>, flag: string): string {
  const value = options.get(flag);
  if (!value) {
    throw new TypeError(`Missing human-calibration option: ${flag}`);
  }
  return value;
}

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  human-calibration export --input QUALITY.json --output DIR",
      "  human-calibration score --packet DIR --labels LABELS.csv --output DIR",
      "  human-calibration validate-export --packet DIR",
      `  Set ${HUMAN_CALIBRATION_SECRET_ENV} in the coordinator environment.`,
      "  human-calibration validate-score --input human-calibration.json",
    ].join("\n")
  );
}

try {
  await main();
} catch {
  process.stderr.write("human-calibration-failure\n");
  process.exitCode = 1;
}
