import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "./human-calibration-utils";

export interface CommandReceiptEvidence {
  readonly argv: readonly string[];
  readonly sha256: string;
}

export async function validateCompletedCommandReceipt({
  expected,
  path,
  pathFlags = [],
}: {
  readonly expected: Readonly<Record<string, string>>;
  readonly path: string;
  readonly pathFlags?: readonly string[];
}): Promise<CommandReceiptEvidence> {
  const contents = await readFile(path, "utf8");
  const raw: unknown = JSON.parse(contents);
  if (!isRecord(raw)) {
    throw new TypeError("Command receipt schema is invalid.");
  }
  const argv = raw.argv;
  if (!Array.isArray(argv)) {
    throw new TypeError("Command receipt schema is invalid.");
  }
  const receipt = raw;
  const startedAt = receipt.startedAt;
  const completedAt = receipt.completedAt;
  if (
    receipt.status !== "completed" ||
    receipt.error !== null ||
    !validTimestamp(startedAt) ||
    !validTimestamp(completedAt) ||
    Date.parse(completedAt) < Date.parse(startedAt)
  ) {
    throw new TypeError("Command receipt is not completed.");
  }
  const options = parseExactOptions(argv);
  if (
    options.size !== Object.keys(expected).length ||
    Object.entries(expected).some(([flag, value]) => {
      const actual = options.get(flag);
      return pathFlags.includes(flag)
        ? actual === undefined || resolve(actual) !== resolve(value)
        : actual !== value;
    })
  ) {
    throw new TypeError("Command receipt argv is invalid.");
  }
  return {
    argv: stringArguments(argv),
    sha256: sha256(contents),
  };
}

function parseExactOptions(
  raw: readonly unknown[]
): ReadonlyMap<string, string> {
  const argv = raw[0] === "--" ? raw.slice(1) : raw;
  if (argv.length === 0 || argv.length % 2 !== 0) {
    throw new TypeError("Command receipt argv is malformed.");
  }
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      typeof flag !== "string" ||
      !flag.startsWith("--") ||
      typeof value !== "string" ||
      value.length === 0 ||
      options.has(flag)
    ) {
      throw new TypeError("Command receipt argv is malformed.");
    }
    options.set(flag, value);
  }
  return options;
}

function stringArguments(argv: readonly unknown[]): readonly string[] {
  const values: string[] = [];
  for (const value of argv) {
    if (typeof value !== "string") {
      throw new TypeError("Command receipt argv is malformed.");
    }
    values.push(value);
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
