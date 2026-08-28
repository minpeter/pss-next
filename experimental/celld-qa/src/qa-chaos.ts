import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  cleanupCompleteEvent,
  cleanupReceiptBinding,
  writeCleanupReceipt,
} from "./campaign-cleanup";
import { measureCleanupRemaining } from "./campaign-cleanup-measure";
import {
  normalizeCliArguments,
  requiredStringOption,
} from "./campaign-cli-utils";
import {
  buildCampaignReport,
  type JsonValue,
  writeCampaignReport,
} from "./campaign-report";

const execFile = promisify(execFileCallback);
const RUNTIME_ROOT = resolve(import.meta.dirname, "../../../packages/runtime");
const ALARM_TESTS = ["src/platform/celld/scheduler-chaos.test.ts"] as const;
const ORDERING_TESTS = [
  "src/platform/celld/scheduler-ordering.test.ts",
] as const;
const MIGRATION_TESTS = [
  "src/platform/celld/scheduled-work-migration.test.ts",
] as const;
const DRAINER_TESTS = ["src/platform/celld/drainer-chaos.test.ts"] as const;
const CHAOS_TESTS = [
  ...ALARM_TESTS,
  ...ORDERING_TESTS,
  ...MIGRATION_TESTS,
  ...DRAINER_TESTS,
] as const;
const CLOUDFLARE_TESTS = [
  "src/platform/cloudflare/host/scheduler-contract.test.ts",
  "src/platform/cloudflare/storage/execution/store-transaction.test.ts",
  "src/platform/cloudflare/storage/sqlite/bootstrap.test.ts",
] as const;

export async function runCampaignCommand(
  args: readonly string[]
): Promise<void> {
  const normalized = normalizeCliArguments(args);
  const reportPath = requiredStringOption(normalized, "--report");
  const runId = randomUUID();
  const cleanupPath = `${reportPath}.cleanup.jsonl`;
  await mkdir(dirname(reportPath), { recursive: true });

  const celldResult = await runTests(CHAOS_TESTS);
  const cloudflareResult = await runTests(CLOUDFLARE_TESTS);
  const output = [
    `CELLD\n${celldResult.stdout}\n${celldResult.stderr}`,
    `CLOUDFLARE\n${cloudflareResult.stdout}\n${cloudflareResult.stderr}`,
  ]
    .join("\n")
    .trim();
  const celldPass = celldResult.exitCode === 0;
  const cloudflarePass = cloudflareResult.exitCode === 0;
  const cleanup = cleanupCompleteEvent(
    await measureCleanupRemaining({
      containerNames: [],
      pids: [],
      ports: [],
      prefixObjectChecks: [],
      proxyFaultChecks: [],
      watchPaths: [],
    })
  );
  await writeCleanupReceipt(
    cleanupPath,
    [cleanup],
    cleanupReceiptBinding(runId, "chaos")
  );
  const report = buildCampaignReport({
    cleanup: { passed: cleanup.passed, receiptPath: cleanupPath },
    command: "chaos",
    runId,
    scenarios: buildChaosScenarios(celldPass, cloudflarePass, output),
  });
  await writeCampaignReport(reportPath, report);
  if (!report.passed) {
    throw new Error(`Celld chaos campaign failed: ${reportPath}`);
  }
  console.log(JSON.stringify(report));
}

export function buildChaosScenarios(
  celldPass: boolean,
  cloudflarePass: boolean,
  output: string
): readonly {
  readonly name: string;
  readonly observables: Readonly<Record<string, JsonValue>>;
  readonly violations: readonly string[];
}[] {
  return [
    {
      name: "alarm-boundaries",
      observables: {
        testFiles: [...ALARM_TESTS, ...DRAINER_TESTS],
        testOutput: output,
        testsPassed: celldPass,
      },
      violations: celldPass ? [] : ["scheduler chaos tests failed"],
    },
    {
      name: "ordering",
      observables: {
        testFiles: [...ORDERING_TESTS],
        testsPassed: celldPass,
      },
      violations: celldPass ? [] : ["ordering tests failed"],
    },
    {
      name: "migration",
      observables: {
        celldTestFiles: [...MIGRATION_TESTS],
        celldTestsPassed: celldPass,
        cloudflareTestFiles: [...CLOUDFLARE_TESTS],
        cloudflareTestsPassed: cloudflarePass,
      },
      violations: [
        ...(celldPass ? [] : ["migration tests failed"]),
        ...(cloudflarePass ? [] : ["Cloudflare regression tests failed"]),
      ],
    },
  ];
}

async function runTests(files: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  try {
    const result = await execFile("pnpm", ["exec", "vitest", "run", ...files], {
      cwd: RUNTIME_ROOT,
      maxBuffer: 20 * 1024 * 1024,
    });
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
