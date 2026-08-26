import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const DEADLINES = [5000, 10_000, 15_000, 20_000];

describe("deadline-sweep CLI artifact", () => {
  it("validates and compares every configured deadline arm", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-deadline-sweep-test-"));
    const output = join(root, "comparison");

    try {
      const inputs = await Promise.all(
        DEADLINES.map(async (deadlineMs) => {
          const path = join(root, `${deadlineMs}.json`);
          await writeFile(path, JSON.stringify(reportFixture(deadlineMs)));
          return path;
        })
      );

      await execFileAsync(
        "pnpm",
        [
          "run",
          "deadline-sweep",
          "--",
          "--inputs",
          inputs.join(","),
          "--output",
          output,
        ],
        { cwd: import.meta.dirname }
      );

      const report = parseCliReport(
        JSON.parse(await readFile(join(output, "deadline-sweep.json"), "utf8"))
      );
      const markdown = await readFile(
        join(output, "deadline-sweep.md"),
        "utf8"
      );

      expect(report.deadlinesMs).toEqual(DEADLINES);
      expect(Object.keys(report.scenarios)).toContain("overlap-nonblocking");
      expect(Object.keys(report.pareto).length).toBeGreaterThan(0);
      expect(markdown).toContain(
        "| Deadline | Provider start | Timeout | Candidate applied |"
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

interface CliReport {
  readonly deadlinesMs: readonly number[];
  readonly pareto: Readonly<Record<string, readonly number[]>>;
  readonly scenarios: Readonly<Record<string, unknown>>;
}

function parseCliReport(raw: unknown): CliReport {
  if (!isRecord(raw)) {
    throw new TypeError("Deadline sweep CLI report is invalid.");
  }
  const deadlinesMs = raw.deadlinesMs;
  if (!Array.isArray(deadlinesMs)) {
    throw new TypeError("Deadline sweep CLI report is invalid.");
  }
  if (!deadlinesMs.every((value) => typeof value === "number")) {
    throw new TypeError("Deadline sweep CLI report is invalid.");
  }
  const paretoRaw = record(raw.pareto);
  const pareto: Record<string, readonly number[]> = {};
  for (const [scenario, values] of Object.entries(paretoRaw)) {
    if (!Array.isArray(values)) {
      throw new TypeError("Deadline sweep CLI report is invalid.");
    }
    if (!values.every((value) => typeof value === "number")) {
      throw new TypeError("Deadline sweep CLI report is invalid.");
    }
    pareto[scenario] = values;
  }
  return { deadlinesMs, pareto, scenarios: record(raw.scenarios) };
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("Deadline sweep CLI report is invalid.");
  }
  return Object.fromEntries(Object.entries(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportFixture(deadlineMs: number): object {
  return {
    attempts: [
      {
        repetition: 1,
        scenario: "overlap-nonblocking",
        status: "completed",
      },
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
