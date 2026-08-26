import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runComparisonCli } from "./compare-reports";
import { renderComparisonMarkdown } from "./comparison-report";

const temporaryDirectories: string[] = [];
const TERMINAL_ACTIVE_CATEGORY = /[\p{Cf}\p{Zl}\p{Zp}]/u;
const TERMINAL_ACTIVE_UNICODE = Array.from(
  { length: 1_114_112 },
  (_, codePoint) => String.fromCodePoint(codePoint)
).filter((character) => TERMINAL_ACTIVE_CATEGORY.test(character));
const KNOWN_FAILURE_STATUSES = [
  "compaction-prompt-failure",
  "evaluation-provider-failure",
  "invalid-full-control",
  "non-compressing-summary",
  "protocol-failure",
  "summary-provider-failure",
] as const;

const arm = {
  compressionMean: null,
  invalid: 0,
  retained: 0,
  semanticRetained: 0,
  total: 0,
  valid: 0,
};

function artifact(model: string, statuses: readonly string[] = []) {
  return {
    aggregate: { overall: { pi: arm, pss: arm } },
    model,
    rows: statuses.map((status) => ({
      pi: { status: "valid" },
      pss: { status },
    })),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function invoke(value: Readonly<Record<string, unknown>>) {
  const directory = await mkdtemp(join(tmpdir(), "comparison-security-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "comparison.json");
  await writeFile(path, JSON.stringify(value));
  let stderr = "";
  let stdout = "";
  const exitCode = await runComparisonCli(["--table", path], {
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { exitCode, stderr, stdout };
}

describe("comparison report security boundary", () => {
  it("rejects provider prose statuses without writing their secrets", async () => {
    // Given
    const secret = "RAW_PROVIDER_SECRET Bearer sk-live-123";

    // When
    const result = await invoke(artifact("benchmark-model", [secret]));

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "COMPARISON_ARTIFACT_INVALID\n",
      stdout: "",
    });
    expect(result.stderr).not.toContain(secret);
  });

  it("rejects U+200B before it leaks through comparison Markdown", () => {
    // Given
    const value = artifact("benchmark\u200bmodel");

    // When / Then
    expect(() => renderComparisonMarkdown(value)).toThrow();
  });

  it.each(TERMINAL_ACTIVE_UNICODE)(
    "rejects terminal-active Unicode %# before comparison Markdown rendering",
    (character) => {
      // Given
      const value = artifact(`benchmark${character}model`);

      // When / Then
      expect(() => renderComparisonMarkdown(value)).toThrow();
    }
  );

  it("counts 150,000 known failures without argument overflow", async () => {
    // Given
    const statuses = Array.from({ length: 150_000 }, () => "protocol-failure");

    // When
    const result = await invoke(artifact("benchmark-model", statuses));

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("| PSS | protocol-failure | 150000 |");
  });

  it("preserves every known failure status and its count", async () => {
    // Given
    const statuses = KNOWN_FAILURE_STATUSES.flatMap((status, index) =>
      Array.from({ length: index + 1 }, () => status)
    );

    // When
    const result = await invoke(artifact("benchmark-model", statuses));

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const [index, status] of KNOWN_FAILURE_STATUSES.entries()) {
      expect(result.stdout).toContain(`| PSS | ${status} | ${index + 1} |`);
    }
  });

  it.each([
    ["ANSI escape", "model\u001b[31m", "protocol-failure"],
    ["C0 control", "benchmark-model", "invalid\u0007status"],
    ["C1 control", "benchmark-model", "invalid\u009b31m"],
    ["line separator", "benchmark\u2028model", "protocol-failure"],
    ["paragraph separator", "benchmark-model", "invalid\u2029status"],
    ["bidi override", "benchmark\u202emodel", "protocol-failure"],
    ["bidi isolate", "benchmark-model", "invalid\u2066status"],
  ])(
    "rejects %s bytes without terminal output",
    async (_name, model, status) => {
      // Given / When
      const result = await invoke(artifact(model, [status]));

      // Then
      expect(result).toEqual({
        exitCode: 1,
        stderr: "COMPARISON_ARTIFACT_INVALID\n",
        stdout: "",
      });
    }
  );

  it("rejects newlines without terminal output", async () => {
    // Given / When
    const result = await invoke(artifact("benchmark\nmodel"));

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "COMPARISON_ARTIFACT_INVALID\n",
      stdout: "",
    });
  });

  it("preserves pipe and backslash characters in a valid model label", async () => {
    // Given / When
    const result = await invoke(
      artifact("benchmark|\\model", ["protocol-failure"])
    );

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Model: `benchmark|\\model`");
    expect(result.stdout).toContain("| PSS | protocol-failure | 1 |");
  });

  it("rejects raw HTML in an unknown failure status", async () => {
    // Given / When
    const result = await invoke(
      artifact("benchmark-model", ['<img src=x onerror="alert(1)">'])
    );

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "COMPARISON_ARTIFACT_INVALID\n",
      stdout: "",
    });
  });

  it.each([
    ["model", artifact("m".repeat(257))],
    ["status", artifact("benchmark-model", ["s".repeat(257)])],
  ])("rejects an overlong %s label", async (_name, value) => {
    // Given / When
    const result = await invoke(value);

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "COMPARISON_ARTIFACT_INVALID\n",
      stdout: "",
    });
  });

  it("accepts bounded ordinary Unicode model labels", async () => {
    // Given / When
    const result = await invoke(
      artifact("模型/café/🙂", ["summary-provider-failure"])
    );

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Model: `模型/café/🙂`");
    expect(result.stdout).toContain("| PSS | summary-provider-failure | 1 |");
  });
});
