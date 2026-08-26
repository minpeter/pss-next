import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseRuntimeDeadlineReport } from "./runtime-deadline-outcome-cli-support";

const execFileAsync = promisify(execFile);

describe("runtime deadline outcome CLI", () => {
  it("resumes without clobbering completed cells", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-deadline-resume-test-"));
    try {
      await run(root, 1);
      const first = await report(root);
      await run(root, 2);
      const resumed = await report(root);
      const rawReceipt: unknown = JSON.parse(
        await readFile(
          join(root, "runtime-deadline-outcome-command.json"),
          "utf8"
        )
      );
      const receipt = parseRuntimeDeadlineReceipt(rawReceipt);

      expect(first.attempts).toHaveLength(6);
      expect(resumed.attempts).toHaveLength(12);
      expect(
        resumed.attempts.filter((attempt) => attempt.repetition === 1)
      ).toEqual(first.attempts);
      expect(new Set(resumed.attempts.map(attemptKey)).size).toBe(12);
      expect(receipt.status).toBe("completed");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);
});

async function run(output: string, repetitions: number): Promise<void> {
  await execFileAsync(
    "pnpm",
    [
      "run",
      "deadline-outcome",
      "--",
      "--mode",
      "deterministic",
      "--deadline-ms",
      "5000",
      "--start-repetition",
      String(repetitions),
      "--repetitions",
      String(repetitions),
      "--output",
      output,
    ],
    { cwd: import.meta.dirname }
  );
}

async function report(output: string) {
  const raw: unknown = JSON.parse(
    await readFile(join(output, "runtime-deadline-outcome.json"), "utf8")
  );
  return parseRuntimeDeadlineReport(raw);
}

function parseRuntimeDeadlineReceipt(raw: unknown): {
  readonly status: "completed" | "failed" | "running";
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("Runtime deadline receipt must be an object.");
  }
  const status = Reflect.get(raw, "status");
  if (status !== "completed" && status !== "failed" && status !== "running") {
    throw new TypeError("Runtime deadline receipt status is invalid.");
  }
  return { status };
}

function attemptKey(attempt: {
  readonly repetition: number;
  readonly scenario: string;
}): string {
  return `${attempt.scenario}:${attempt.repetition}`;
}
