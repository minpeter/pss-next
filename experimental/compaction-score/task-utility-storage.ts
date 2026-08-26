import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTaskUtilityPairs } from "./task-utility-evidence-validation";
import type {
  TaskUtilityCheckpointIdentity,
  TaskUtilityPair,
  TaskUtilityReport,
} from "./task-utility-types";

export async function loadTaskUtilityPartial(
  outputDirectory: string,
  identity: TaskUtilityCheckpointIdentity
): Promise<readonly TaskUtilityPair[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(join(outputDirectory, "task-utility.partial.json"), "utf8")
    );
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Reflect.get(raw, "schemaVersion") !== "task-utility-partial-v2" ||
    !matchesIdentity(raw, identity)
  ) {
    throw new TypeError("Existing task utility partial identity mismatch.");
  }
  const pairs = parseTaskUtilityPairs(Reflect.get(raw, "pairs"));
  assertUniquePairs(pairs);
  return pairs;
}

export async function writeTaskUtilityPartial(
  outputDirectory: string,
  identity: TaskUtilityCheckpointIdentity,
  pairs: readonly TaskUtilityPair[]
): Promise<void> {
  assertUniquePairs(pairs);
  await atomicWrite(
    join(outputDirectory, "task-utility.partial.json"),
    `${JSON.stringify(
      { ...identity, pairs, schemaVersion: "task-utility-partial-v2" },
      null,
      2
    )}\n`
  );
}

export async function writeTaskUtilityReport(
  outputDirectory: string,
  report: TaskUtilityReport,
  markdown: string
): Promise<void> {
  await Promise.all([
    atomicWrite(
      join(outputDirectory, "task-utility.json"),
      `${JSON.stringify(report, null, 2)}\n`
    ),
    atomicWrite(join(outputDirectory, "task-utility.md"), markdown),
  ]);
}

export async function writeTaskUtilityReceipt(
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
    join(outputDirectory, "task-utility-command.json"),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

function matchesIdentity(
  raw: object,
  identity: TaskUtilityCheckpointIdentity
): boolean {
  const policy = Reflect.get(raw, "policy");
  return (
    Reflect.get(raw, "mode") === identity.mode &&
    Reflect.get(raw, "model") === identity.model &&
    Reflect.get(raw, "repetitions") === identity.repetitions &&
    JSON.stringify(Reflect.get(raw, "fixtures")) ===
      JSON.stringify(identity.fixtures) &&
    typeof policy === "object" &&
    policy !== null &&
    !Array.isArray(policy) &&
    Reflect.get(policy, "attemptTimeoutMs") ===
      identity.policy.attemptTimeoutMs &&
    Reflect.get(policy, "fullControlAttempts") ===
      identity.policy.fullControlAttempts &&
    Reflect.get(policy, "validator") === identity.policy.validator
  );
}

function assertUniquePairs(pairs: readonly TaskUtilityPair[]): void {
  const keys = pairs.map((pair) => `${pair.fixture}:${pair.repetition}`);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("Task utility partial contains duplicate pairs.");
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

export function parseTaskUtilityReceipt(raw: unknown): {
  argv: string[];
  readonly status: "completed" | "failed" | "running";
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("Task utility receipt must be an object.");
  }
  const argv = Reflect.get(raw, "argv");
  const status = Reflect.get(raw, "status");
  if (
    !(
      Array.isArray(argv) && argv.every((value) => typeof value === "string")
    ) ||
    (status !== "completed" && status !== "failed" && status !== "running")
  ) {
    throw new TypeError("Task utility receipt schema is invalid.");
  }
  return { argv, status };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}
