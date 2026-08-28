import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { cleanupCompleteEvent, writeCleanupReceipt } from "./campaign-cleanup";
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

const scenarioResultSchema = z
  .record(z.string(), z.json())
  .refine((value) => typeof value.passed === "boolean", {
    message: "Scenario response requires a boolean passed field.",
  });

const scenarioNames = [
  "tool-checkpoint",
  "input-ordering",
  "compaction",
  "large-history",
  "attachment",
] as const;
type ScenarioName = (typeof scenarioNames)[number];
type ScenarioPhase = "run" | "verify";

export interface RealAgentCampaignOptions {
  readonly port: number;
  readonly report: string;
}

export interface RealAgentCampaignDependencies<TChild = unknown> {
  readonly cleanupPrefix: (prefix: string) => Promise<void>;
  readonly createBucket: () => Promise<void>;
  readonly deploy: (prefix: string) => Promise<void>;
  readonly fetchScenario: (
    baseUrl: string,
    scenario: ScenarioName,
    phase: ScenarioPhase,
    token: string
  ) => Promise<Readonly<Record<string, JsonValue>>>;
  readonly makeWatchDirectory: () => Promise<string>;
  readonly removeWatchDirectory: (path: string) => Promise<void>;
  readonly restartCelld: (
    prefix: string,
    port: number,
    watch: string,
    child: TChild
  ) => Promise<TChild>;
  readonly startCelld: (prefix: string, port: number, watch: string) => TChild;
  readonly stopCelld: (child: TChild) => Promise<void>;
  readonly waitForListening: (child: TChild) => Promise<void>;
}

export async function runRealAgentCampaign<TChild>(
  options: RealAgentCampaignOptions,
  dependencies: RealAgentCampaignDependencies<TChild>
): Promise<CampaignReport> {
  const runId = randomUUID();
  const prefix = `real-agent-${runId.slice(0, 8)}`;
  const watch = await dependencies.makeWatchDirectory();
  const receiptPath = `${options.report}.cleanup.jsonl`;
  let child: TChild | undefined;
  const cleanup = async (): Promise<void> => {
    if (child !== undefined) {
      await dependencies.stopCelld(child);
      child = undefined;
    }
    await dependencies.cleanupPrefix(prefix);
    await dependencies.removeWatchDirectory(watch);
    await writeCleanupReceipt(receiptPath, [
      cleanupCompleteEvent({
        containers: 0,
        ports: 0,
        prefixObjects: 0,
        processes: 0,
        proxyFaults: 0,
        watchPaths: 0,
      }),
    ]);
  };
  const scenarios = await runWithCampaignCleanup({
    cleanup,
    run: async () => {
      await dependencies.createBucket();
      await dependencies.deploy(prefix);
      child = dependencies.startCelld(prefix, options.port, watch);
      await dependencies.waitForListening(child);
      const baseUrl = `http://127.0.0.1:${options.port}`;
      const token = runId;

      const toolRun = await dependencies.fetchScenario(
        baseUrl,
        "tool-checkpoint",
        "run",
        token
      );
      child = await dependencies.restartCelld(
        prefix,
        options.port,
        watch,
        child
      );
      const toolVerify = await dependencies.fetchScenario(
        baseUrl,
        "tool-checkpoint",
        "verify",
        token
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
        scenario("tool-checkpoint-restart", { ...toolRun, ...toolVerify }),
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
    cleanup: { passed: true, receiptPath },
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
  const response = await fetch(
    `${baseUrl}/real-agent?object=${encodeURIComponent(`${scenario}:${token}`)}`,
    {
      body: JSON.stringify({ phase, scenario, token }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  const value: unknown = await response.json();
  if (!response.ok) {
    throw new TypeError(
      `Real-agent scenario failed with HTTP ${response.status}.`
    );
  }
  return scenarioResultSchema.parse(value);
}

const defaultDependencies: RealAgentCampaignDependencies<
  ReturnType<typeof startCelld>
> = {
  cleanupPrefix,
  createBucket,
  deploy,
  fetchScenario,
  makeWatchDirectory: () => mkdtemp(join(tmpdir(), "pss-celld-real-agent-")),
  removeWatchDirectory: (path) => rm(path, { force: true, recursive: true }),
  restartCelld: (prefix, port, watch, child) =>
    restartCelld("native", prefix, port, watch, child),
  startCelld: (prefix, port, watch) =>
    startCelld("native", prefix, port, watch),
  stopCelld,
  waitForListening,
};

export async function runCampaignCommand(
  args: readonly string[]
): Promise<void> {
  const normalized = normalizeCliArguments(args);
  const report = requiredStringOption(normalized, "--report");
  const port = integerOption(normalized, "--port", 16_431);
  await runRealAgentCampaign({ port, report }, defaultDependencies);
}
