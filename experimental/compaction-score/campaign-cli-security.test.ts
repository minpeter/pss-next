import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { typescriptSubprocessArguments } from "./typescript-subprocess.test-support";

const SUBPROCESS_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;
const CONTROL_PATH = "path\u001b\u0007\u0085\n\u200e\u2028\u2029\u{e0001}";
const temporaryDirectories: string[] = [];

interface CliResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface FailureCase {
  readonly arguments: (
    root: string,
    output: string
  ) => Promise<readonly string[]>;
  readonly entrypoint: string;
  readonly sentinel: string;
}

async function readStream(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let contents = "";
  for await (const chunk of stream) {
    contents += String(chunk);
  }
  return contents;
}

async function killAndClose(
  child: ChildProcess,
  closed: Promise<unknown>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed;
    return;
  }
  child.kill("SIGKILL");
  await Promise.race([
    closed,
    once(AbortSignal.timeout(5000), "abort").then(() => {
      throw new Error("Timed out while closing campaign CLI subprocess.");
    }),
  ]);
}

async function runCli(
  entrypoint: string,
  arguments_: readonly string[]
): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    typescriptSubprocessArguments(entrypoint, arguments_),
    {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        AI_API_KEY: "failure\u001b\u0007\u0085\n\u200e\u2028\u2029\u{e0001}",
        AI_BASE_URL: "http://127.0.0.1:1/v1",
        AI_MODEL: "model\u001b\u0007\u0085\n\u200e\u2028\u2029\u{e0001}",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const closed = once(child, "close");
  const stdout = readStream(child.stdout);
  const stderr = readStream(child.stderr);
  const timedOut = await Promise.race([
    closed.then(() => false),
    once(AbortSignal.timeout(SUBPROCESS_TIMEOUT_MS), "abort").then(() => true),
  ]);
  if (timedOut) {
    await killAndClose(child, closed);
    throw new Error("Campaign CLI subprocess timed out.");
  }
  const [stdoutValue, stderrValue] = await Promise.all([stdout, stderr]);
  return { code: child.exitCode, stderr: stderrValue, stdout: stdoutValue };
}

async function deadlineArguments(
  root: string,
  output: string
): Promise<readonly string[]> {
  const inputs = await Promise.all(
    [5000, 10_000, 15_000, 20_000].map(async (deadlineMs) => {
      const path = join(root, `${deadlineMs}.json`);
      await writeFile(path, JSON.stringify(deadlineFixture(deadlineMs)));
      return path;
    })
  );
  return ["--inputs", inputs.join(","), "--output", output];
}

function deadlineFixture(deadlineMs: number): object {
  return {
    attempts: [
      { repetition: 1, scenario: "overlap-nonblocking", status: "completed" },
    ],
    createdAt: "2026-08-15T00:00:00.000Z",
    deadlineMs,
    mode: "deterministic",
    model: "deterministic-mock",
    trials: [
      {
        candidateApplied: false,
        deadlineMs,
        decisionLatencyMs: 0,
        outcome: "provider-started",
        providerStarted: true,
        repetition: 1,
        scenario: "overlap-nonblocking",
        summaryCallsStarted: 1,
        summarySpans: [],
      },
    ],
  };
}

const deterministicArguments = async (
  _root: string,
  output: string
): Promise<readonly string[]> => [
  "--mode",
  "deterministic",
  "--repetitions",
  "1",
  "--output",
  output,
];

const failureCases: readonly FailureCase[] = [
  {
    entrypoint: "quality-sweep-cli.ts",
    sentinel: "quality-sweep-failure\n",
    arguments: deterministicArguments,
  },
  {
    entrypoint: "runtime-deadline-outcome-cli.ts",
    sentinel: "runtime-deadline-outcome-failure\n",
    arguments: async (_root, output) => [
      "--mode",
      "deterministic",
      "--deadline-ms",
      "5000",
      "--repetitions",
      "1",
      "--output",
      output,
    ],
  },
  {
    entrypoint: "task-utility-cli.ts",
    sentinel: "task-utility-failure\n",
    arguments: deterministicArguments,
  },
  {
    entrypoint: "deadline-sweep-cli.ts",
    sentinel: "deadline-sweep-failure\n",
    arguments: deadlineArguments,
  },
  {
    entrypoint: "production-overlap-cli.ts",
    sentinel: "production-overlap-failure\n",
    arguments: deterministicArguments,
  },
  {
    entrypoint: "five-track-cli.ts",
    sentinel: "five-track-failure\n",
    arguments: async (_root, output) => [
      "--quality",
      output,
      "--task",
      output,
      "--human",
      output,
      "--production",
      output,
      "--deadline",
      output,
      "--output",
      output,
    ],
  },
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("campaign CLI terminal boundaries", () => {
  it.each(failureCases)(
    "$entrypoint emits only its static sentinel on a controlled-path failure",
    async ({ arguments: createArguments, entrypoint, sentinel }) => {
      // Given
      const root = await mkdtemp(join(tmpdir(), "campaign-cli-security-"));
      temporaryDirectories.push(root);
      const blocker = join(root, "blocker");
      await writeFile(blocker, "not a directory");
      const output = join(blocker, CONTROL_PATH);

      // When
      const result = await runCli(
        entrypoint,
        await createArguments(root, output)
      );

      // Then
      expect(result).toEqual({ code: 1, stderr: sentinel, stdout: "" });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "encodes output path controls in a successful report location",
    async () => {
      // Given
      const root = await mkdtemp(join(tmpdir(), "campaign-cli-security-"));
      temporaryDirectories.push(root);
      const output = join(root, CONTROL_PATH);

      // When
      const result = await runCli(
        "quality-sweep-cli.ts",
        await deterministicArguments(root, output)
      );

      // Then
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `report: ${JSON.stringify(output).replace(
          /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
          (character) => {
            const codePoint = character.codePointAt(0);
            if (codePoint === undefined) {
              throw new TypeError("Expected a Unicode scalar.");
            }
            if (codePoint <= 0xff_ff) {
              return `\\u${codePoint.toString(16).padStart(4, "0")}`;
            }
            const scalar = codePoint - 0x1_00_00;
            const high = 0xd8_00 + Math.floor(scalar / 0x4_00);
            const low = 0xdc_00 + (scalar % 0x4_00);
            return `\\u${high.toString(16)}\\u${low.toString(16)}`;
          }
        )}\n`
      );
    },
    TEST_TIMEOUT_MS
  );
});
