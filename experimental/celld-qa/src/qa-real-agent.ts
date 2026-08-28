import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  cleanupCompleteEvent,
  cleanupReceiptBinding,
  requireMeasuredCleanupPassed,
  writeCleanupReceipt,
} from "./campaign-cleanup";
import {
  integerOption,
  normalizeCliArguments,
  requiredStringOption,
} from "./campaign-cli-utils";
import { runWithCampaignCleanup } from "./campaign-lifecycle";
import {
  buildCampaignReport,
  type CampaignReport,
  type JsonValue,
  writeCampaignReport,
} from "./campaign-report";
import { cleanupPrefix } from "./celld-bucket";
import {
  createBucket,
  deploy,
  restartCelld,
  startCelld,
  stopCelld,
  waitForListening,
} from "./celld-process";
import {
  fetchRealAgentScenario,
  interruptRealAgentScenario,
  waitForChildProcessExit,
  whileProcessLives,
} from "./qa-real-agent-http";
import type {
  RealAgentCampaignDependencies,
  RealAgentCampaignOptions,
  ScenarioName,
  ScenarioPhase,
} from "./qa-real-agent-types";
import { measureRealAgentCleanup } from "./real-agent-cleanup";

export type {
  RealAgentCampaignDependencies,
  RealAgentCampaignOptions,
} from "./qa-real-agent-types";

const scenarioResultSchema = z
  .record(z.string(), z.json())
  .refine((value) => typeof value.passed === "boolean", {
    message: "Scenario response requires a boolean passed field.",
  });

export async function runRealAgentCampaign<TChild>(
  options: RealAgentCampaignOptions,
  dependencies: RealAgentCampaignDependencies<TChild>
): Promise<CampaignReport> {
  const runId = randomUUID();
  const prefix = `real-agent-${runId.slice(0, 8)}`;
  const watch = await dependencies.makeWatchDirectory();
  const receiptPath = `${options.report}.cleanup.jsonl`;
  let child: TChild | undefined;
  const children: TChild[] = [];
  let cleanupPassed: boolean | undefined;
  const cleanup = async (): Promise<void> => {
    if (child !== undefined) {
      await dependencies.stopCelld(child);
      child = undefined;
    }
    await dependencies.cleanupPrefix(prefix);
    await dependencies.removeWatchDirectory(watch);
    const remaining = await dependencies.measureCleanup({
      children,
      port: options.port,
      prefix,
      watch,
    });
    const cleanupEvent = cleanupCompleteEvent(remaining);
    cleanupPassed = cleanupEvent.passed;
    await writeCleanupReceipt(
      receiptPath,
      [cleanupEvent],
      cleanupReceiptBinding(runId, "real-agent")
    );
  };
  const scenarios = await runWithCampaignCleanup({
    cleanup,
    run: async () => {
      await dependencies.createBucket();
      await dependencies.deploy(prefix);
      child = dependencies.startCelld(prefix, options.port, watch);
      children.push(child);
      await dependencies.waitForListening(child);
      const baseUrl = `http://127.0.0.1:${options.port}`;
      const token = runId;

      await whileProcessLives(child, dependencies.waitForProcessExit, () =>
        dependencies.interruptScenario(baseUrl, "tool-checkpoint", token)
      );
      child = await dependencies.restartCelld(
        prefix,
        options.port,
        watch,
        child
      );
      children.push(child);
      const toolVerify = await whileProcessLives(
        child,
        dependencies.waitForProcessExit,
        () =>
          dependencies.fetchScenario(
            baseUrl,
            "tool-checkpoint",
            "resume",
            token
          )
      );
      const ordering = await dependencies.fetchScenario(
        baseUrl,
        "input-ordering",
        "run",
        token
      );
      const compactionRun = await dependencies.fetchScenario(
        baseUrl,
        "compaction",
        "run",
        token
      );
      child = await dependencies.restartCelld(
        prefix,
        options.port,
        watch,
        child
      );
      children.push(child);
      const compactionVerify = await dependencies.fetchScenario(
        baseUrl,
        "compaction",
        "verify",
        token
      );
      const largeHistory = await dependencies.fetchScenario(
        baseUrl,
        "large-history",
        "run",
        token
      );
      const attachment = await dependencies.fetchScenario(
        baseUrl,
        "attachment",
        "run",
        token
      );
      return [
        scenario("tool-checkpoint-restart", toolVerify),
        scenario("input-ordering", ordering),
        scenario("compaction-restart", {
          ...compactionRun,
          continuityMarkers: compactionVerify.markers ?? [],
          passed:
            compactionRun.passed === true && compactionVerify.passed === true,
        }),
        scenario("large-history", largeHistory),
        scenario("attachment-lifecycle", attachment),
      ];
    },
  });
  const report = buildCampaignReport({
    cleanup: {
      passed: requireMeasuredCleanupPassed(cleanupPassed, "Real-agent"),
      receiptPath,
    },
    command: "real-agent",
    runId,
    scenarios,
  });
  await writeCampaignReport(options.report, report);
  return report;
}

function scenario(
  name: string,
  observables: Readonly<Record<string, JsonValue>>
): {
  readonly name: string;
  readonly observables: Readonly<Record<string, JsonValue>>;
  readonly violations: readonly string[];
} {
  return {
    name,
    observables,
    violations: observables.passed === true ? [] : ["binary observable failed"],
  };
}

async function fetchScenario(
  baseUrl: string,
  scenario: ScenarioName,
  phase: ScenarioPhase,
  token: string
): Promise<Readonly<Record<string, JsonValue>>> {
  return scenarioResultSchema.parse(
    await fetchRealAgentScenario(baseUrl, scenario, phase, token)
  );
}

const defaultDependencies: RealAgentCampaignDependencies<
  ReturnType<typeof startCelld>
> = {
  cleanupPrefix,
  createBucket,
  deploy,
  fetchScenario,
  interruptScenario: interruptRealAgentScenario,
  makeWatchDirectory: () => mkdtemp(join(tmpdir(), "pss-celld-real-agent-")),
  measureCleanup: measureRealAgentCleanup,
  removeWatchDirectory: (path) => rm(path, { force: true, recursive: true }),
  restartCelld: (prefix, port, watch, child) =>
    restartCelld("native", prefix, port, watch, child),
  startCelld: (prefix, port, watch) =>
    startCelld("native", prefix, port, watch),
  stopCelld,
  waitForListening,
  waitForProcessExit: waitForChildProcessExit,
};

export async function runCampaignCommand(
  args: readonly string[]
): Promise<void> {
  const normalized = normalizeCliArguments(args);
  const report = requiredStringOption(normalized, "--report");
  const port = integerOption(normalized, "--port", 16_431);
  const campaign = await runRealAgentCampaign(
    { port, report },
    defaultDependencies
  );
  assertRealAgentCampaignPassed(campaign);
}

export function assertRealAgentCampaignPassed(
  report: Pick<CampaignReport, "passed">
): void {
  if (!report.passed) {
    throw new Error("Real-agent campaign report failed.");
  }
}
