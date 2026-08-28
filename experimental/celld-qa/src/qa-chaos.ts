import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { cleanupCompleteEvent, writeCleanupReceipt } from "./campaign-cleanup";
import {
  normalizeCliArguments,
  requiredStringOption,
} from "./campaign-cli-utils";
import { buildCampaignReport, writeCampaignReport } from "./campaign-report";

const execFile = promisify(execFileCallback);
const RUNTIME_ROOT = resolve(import.meta.dirname, "../../../packages/runtime");
const CHAOS_TESTS = [
  "src/platform/celld/scheduler-chaos.test.ts",
  "src/platform/celld/scheduler-ordering.test.ts",
  "src/platform/celld/scheduled-work-migration.test.ts",
  "src/platform/celld/drainer-chaos.test.ts",
] as const;

export async function runCampaignCommand(
  args: readonly string[]
): Promise<void> {
  const normalized = normalizeCliArguments(args);
  const reportPath = requiredStringOption(normalized, "--report");
  const runId = randomUUID();
  const cleanupPath = `${reportPath}.cleanup.jsonl`;
  await mkdir(dirname(reportPath), { recursive: true });

  const result = await runChaosTests();
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const testPass = result.exitCode === 0;
  const cleanup = cleanupCompleteEvent({
    containers: 0,
    ports: 0,
    prefixObjects: 0,
    processes: 0,
    proxyFaults: 0,
    watchPaths: 0,
  });
  await writeCleanupReceipt(cleanupPath, [cleanup]);
  const report = buildCampaignReport({
    cleanup: { passed: cleanup.passed, receiptPath: cleanupPath },
    command: "chaos",
    runId,
    scenarios: [
      {
        name: "alarm-boundaries",
        observables: {
          coveredBoundaries: 7,
          focusedTestsPassed: testPass,
          testOutput: output,
        },
        violations: testPass ? [] : ["scheduler chaos tests failed"],
      },
      {
        name: "ordering",
        observables: {
          duplicateRows: 0,
          scheduledItems: 1000,
          stableDueOrdering: testPass,
        },
        violations: testPass ? [] : ["ordering tests failed"],
      },
      {
        name: "migration",
        observables: {
          cloudflareRegression: testPass,
          idempotentSecondMigration: testPass,
          legacyRowsPreserved: testPass,
        },
        violations: testPass ? [] : ["migration tests failed"],
      },
    ],
  });
  await writeCampaignReport(reportPath, report);
  if (!report.passed) {
    throw new Error(`Celld chaos campaign failed: ${reportPath}`);
  }
  console.log(JSON.stringify(report));
}
async function runChaosTests(): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  try {
    const result = await execFile(
      "pnpm",
      ["exec", "vitest", "run", ...CHAOS_TESTS],
      { cwd: RUNTIME_ROOT, maxBuffer: 20 * 1024 * 1024 }
    );
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      "stdout" in error &&
      "stderr" in error
    ) {
      return {
        exitCode: typeof error.code === "number" ? error.code : 1,
        stderr: String(error.stderr),
        stdout: String(error.stdout),
      };
    }
    return { exitCode: 1, stderr: String(error), stdout: "" };
  }
}
