import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateRuntimeBlockTrials,
  type RuntimeBlockScenario,
  type RuntimeBlockTrial,
} from "./runtime-block-time-metrics";
import {
  admitRuntimeBlockTerminalText,
  createRuntimeBlockTimeReport,
  renderRuntimeBlockTimeMarkdown,
} from "./runtime-block-time-report";

const temporaryDirectories: string[] = [];
const TERMINAL_ACTIVE_CATEGORY = /[\p{Cf}\p{Zl}\p{Zp}]/u;
const TERMINAL_ACTIVE_UNICODE = Array.from(
  { length: 1_114_112 },
  (_, codePoint) => String.fromCodePoint(codePoint)
).filter((character) => TERMINAL_ACTIVE_CATEGORY.test(character));
const SCENARIOS = [
  "overlap-nonblocking",
  "prepared-hit",
  "candidate-fit-late-hit",
  "candidate-fit-hard-block",
  "summary-failure-retry-hit",
  "repeated-failure-overflow-recovery",
] as const satisfies readonly RuntimeBlockScenario[];

const trial = {
  avoidedBlockMs: 0,
  blockAvoidanceRatio: 0,
  candidateApplied: false,
  controlPreparationMs: 0,
  controlProviderDispatchMs: 0,
  controlTtfvMs: 0,
  gateDeltaMs: 0,
  overlapAtProviderStart: false,
  preStepDeltaMs: 0,
  repetition: 1,
  scenario: "overlap-nonblocking",
  summaryCalls: 0,
  summaryServiceMs: 0,
  treatmentPreparationMs: 0,
  treatmentProviderDispatchMs: 0,
  treatmentTtfvMs: 0,
  userBlockMs: 0,
  userDeltaMs: 0,
  zeroBlock: true,
} as const satisfies RuntimeBlockTrial;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

function reportForModel(model: string) {
  const trials = SCENARIOS.map((scenario) => ({ ...trial, scenario }));
  return createRuntimeBlockTimeReport({
    createdAt: "2026-08-22T00:00:00.000Z",
    mode: "live",
    model,
    observations: [],
    trials,
  });
}

async function runCli(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {}
) {
  const child = spawn(
    join(import.meta.dirname, "node_modules/.bin/tsx"),
    [
      "--conditions=@minpeter/pss-source",
      join(import.meta.dirname, "runtime-block-time-cli.ts"),
      ...args,
    ],
    {
      cwd: import.meta.dirname,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stderr, stdout };
}

describe("runtime block-time bounded and terminal-safe boundaries", () => {
  it("rejects U+200B at terminal-text admission", () => {
    // Given
    const value = "model\u200blabel";

    // When / Then
    expect(() => admitRuntimeBlockTerminalText(value, 256)).toThrow(TypeError);
  });

  it.each(TERMINAL_ACTIVE_UNICODE)(
    "rejects terminal-active Unicode %# at terminal-text admission",
    (character) => {
      // Given
      const value = `model${character}label`;

      // When / Then
      expect(() => admitRuntimeBlockTerminalText(value, 256)).toThrow(
        TypeError
      );
    }
  );

  it("aggregates 150,000 valid trials without argument overflow", () => {
    // Given
    const trials = Array.from({ length: 150_000 }, (_, index) => ({
      ...trial,
      repetition: index + 1,
      userBlockMs: index,
    }));

    // When
    const aggregate = aggregateRuntimeBlockTrials(
      "overlap-nonblocking",
      trials
    );

    // Then
    expect(aggregate.userBlockMaxMs).toBe(149_999);
    expect(aggregate.trials).toBe(150_000);
  });

  it.each([
    ["C0", "model\u0007label"],
    ["C1", "model\u009blabel"],
    ["ESC", "model\u001b[31m"],
    ["newline", "model\nlabel"],
    ["line separator", "model\u2028label"],
    ["paragraph separator", "model\u2029label"],
    ["bidi override", "model\u202elabel"],
    ["bidi isolate", "model\u2066label"],
    ["lone high surrogate", "model\ud800label"],
    ["lone low surrogate", "model\udc00label"],
    ["reversed surrogate pair", "model\udc00\ud800label"],
    ["overlong", "m".repeat(257)],
  ])("rejects a %s model label before report rendering", (_name, model) => {
    // Given
    const report = reportForModel(model);

    // When / Then
    expect(() => renderRuntimeBlockTimeMarkdown(report)).toThrow(TypeError);
  });

  it.each([
    ["ESC in a repetition value", ["--repetitions", "1\u001bsecret"]],
    ["C0 in a repetition value", ["--repetitions", "1\u0007secret"]],
    ["C1 in a repetition value", ["--repetitions", "1\u009bsecret"]],
    ["newline in a repetition value", ["--repetitions", "1\nsecret"]],
    ["ESC in an unknown flag", ["--unknown\u001bsecret", "value"]],
    ["C0 in an unknown flag", ["--unknown\u0007secret", "value"]],
    ["C1 in an unknown flag", ["--unknown\u009bsecret", "value"]],
    ["newline in an unknown flag", ["--unknown\nsecret", "value"]],
  ])("emits only the stable options error for %s", async (_name, args) => {
    // Given
    const expectedError = "RUNTIME_BLOCK_TIME_OPTIONS_INVALID\n";

    // When
    const result = await runCli(args);

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: expectedError,
      stdout: "",
    });
  });

  it("rejects a real CLI output path containing terminal controls without echoing it", async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "runtime-block-safe-"));
    temporaryDirectories.push(directory);
    const outputDirectory = join(
      directory,
      "unsafe-\u0007-\u009b-\u001b-new\nline"
    );

    // When
    const result = await runCli([
      "--mode",
      "deterministic",
      "--repetitions",
      "1",
      "--output",
      outputDirectory,
    ]);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain(outputDirectory);
    expect(result.stderr).not.toContain(outputDirectory);
  });

  it("rejects a malformed UTF-16 output path at CLI admission", () => {
    // Given
    const outputDirectory = join(tmpdir(), "runtime-block-malformed-\ud800");

    // When
    const admit = () => admitRuntimeBlockTerminalText(outputDirectory, 4096);

    // Then
    expect(admit).toThrow(TypeError);
  });

  it("rejects a real live CLI model label containing terminal controls before provider dispatch", async () => {
    // Given
    const model = "unsafe-\u0007-\u009b-\u001b-new\nline";

    // When
    const result = await runCli(["--mode", "live", "--repetitions", "1"], {
      AI_API_KEY: "test-key",
      AI_BASE_URL: "http://127.0.0.1:9/v1",
      AI_MODEL: model,
    });

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain(model);
    expect(result.stderr).not.toContain(model);
  });

  it("prevents a runtime model label from escaping into raw HTML", () => {
    // Given
    const report = reportForModel(
      'provider`</code><img src=x onerror="alert(1)">'
    );

    // When
    const markdown = renderRuntimeBlockTimeMarkdown(report);

    // Then
    expect(markdown).not.toContain("<img");
    expect(markdown).not.toContain("</code>");
  });

  it("preserves ordinary Unicode and CJK model labels", () => {
    // Given
    const report = reportForModel("提供者/café/🙂");

    // When
    const markdown = renderRuntimeBlockTimeMarkdown(report);

    // Then
    expect(markdown).toContain("Model: `提供者/café/🙂`");
  });
});
