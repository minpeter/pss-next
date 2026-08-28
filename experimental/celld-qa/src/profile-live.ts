import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { cleanupCompleteEvent, writeCleanupReceipt } from "./campaign-cleanup";
import { runWithCampaignCleanup } from "./campaign-lifecycle";
import { cleanupPrefix } from "./celld-bucket";
import {
  type CelldChild,
  createBucket,
  deploy,
  readProcessMetrics,
  restartCelld,
  startCelld,
  stopCelld,
  waitForListening,
} from "./celld-process";
import type {
  ProcessMetricReport,
  ProcessObservation,
} from "./process-observer";
import { PROFILE_PLANS } from "./profile-plans";
import { type ProfileReport, runProfile } from "./profile-runner";
import { summarizeLatencies } from "./profile-statistics";
import type {
  ProfileName,
  ProfileRequest,
  RequestObservation,
} from "./profile-types";
import { type ChurnBatchResult, runRestartChurn } from "./restart-churn";

export interface LiveProfileOptions {
  readonly baseUrl: string;
  readonly port: number;
  readonly profile: ProfileName;
  readonly progressPath?: string;
  readonly reportPath: string;
}

export interface LiveProfileResult {
  readonly cleanupPath: string;
  readonly report: ProfileReport | null;
  readonly runId: string;
}

export async function runLiveProfile(
  options: LiveProfileOptions
): Promise<LiveProfileResult> {
  const runId = randomUUID();
  const prefix = `campaign-profile-${runId}`;
  const watch = await mkdtemp(join("/var/tmp", "pss-celld-profile-"));
  const cleanupPath = `${options.reportPath}.cleanup.jsonl`;
  let child: CelldChild | undefined;
  const cleanup = async (): Promise<void> => {
    if (child !== undefined) {
      await stopCelld(child);
      child = undefined;
    }
    await cleanupPrefix(prefix);
    await rm(watch, { force: true, recursive: true });
    await writeCleanupReceipt(cleanupPath, [
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
  const report = await runWithCampaignCleanup({
    cleanup,
    run: async () => {
      await createBucket();
      await deploy(prefix);
      child = startCelld("native", prefix, options.port, watch);
      await waitForListening(child);
      const result =
        options.profile === "restart"
          ? await runChurnProfile(options, prefix, watch, child, (next) => {
              child = next;
            })
          : {
              report: await runFiniteProfile(options, child.pid ?? undefined),
            };
      return result.report;
    },
  });
  return { cleanupPath, report, runId };
}

function runFiniteProfile(
  options: LiveProfileOptions,
  pid: number | undefined
): Promise<ProfileReport> {
  const plan = PROFILE_PLANS[options.profile];
  if (plan.kind === "restart") {
    throw new Error("restart profile must use the churn runner");
  }
  const progressPath = options.progressPath;
  return runProfile({
    clock: { now: () => performance.now() },
    fetchRequest: requestFetcher(options.baseUrl),
    plan,
    processSampler: async (): Promise<ProcessObservation> => ({
      kind: "celld-native",
      ...(await readProcessMetrics(pid)),
    }),
    progressSink:
      progressPath === undefined
        ? undefined
        : async (line) => {
            await writeFile(progressPath, `${line}\n`, { flag: "a" });
          },
  });
}

async function runChurnProfile(
  options: LiveProfileOptions,
  prefix: string,
  watch: string,
  initialChild: CelldChild,
  onChild: (child: CelldChild) => void
): Promise<{ readonly child: CelldChild; readonly report: ProfileReport }> {
  let child = initialChild;
  const plan = PROFILE_PLANS.restart;
  let totalCorrect = 0;
  let totalCompleted = 0;
  let elapsedMs = 0;
  let samples: number[] = [];
  let processMetrics: ProcessMetricReport | null = null;
  const result = await runRestartChurn({
    restart: async () => {
      child = await restartCelld("native", prefix, options.port, watch, child);
      onChild(child);
    },
    restartEvery: plan.restartEvery,
    runBatch: async (requestCount, offset): Promise<ChurnBatchResult> => {
      const batch = await runProfile({
        clock: { now: () => performance.now() },
        fetchRequest: async (request, signal) =>
          requestFetcher(options.baseUrl)(
            { index: request.index + offset, objectName: request.objectName },
            signal
          ),
        plan: {
          concurrency: plan.concurrency,
          kind: "hot",
          objectCount: 1,
          requestCount,
        },
        processSampler: async () => ({
          kind: "celld-native",
          ...(await readProcessMetrics(child.pid ?? undefined)),
        }),
      });
      totalCorrect += batch.correct;
      totalCompleted += batch.completed;
      elapsedMs += batch.elapsedMs;
      samples = [...samples, ...batch.latencySamples];
      processMetrics = mergeProcessMetrics(
        processMetrics,
        batch.processMetrics
      );
      return {
        cleanup: batch.cleanup,
        completed: batch.completed,
        correct: batch.correct,
      };
    },
    totalRequests: plan.requestCount,
  });
  return {
    child,
    report: {
      admitted: result.completed,
      cleanup: { ...result.cleanup, aborted: 0 },
      completed: totalCompleted,
      correct: totalCorrect,
      elapsedMs,
      failed: result.completed - totalCorrect,
      incorrect: 0,
      latency: samples.length === 0 ? null : summarizeLatencies(samples),
      latencySamples: samples,
      processMetrics,
    },
  };
}

function mergeProcessMetrics(
  left: ProcessMetricReport | null,
  right: ProcessMetricReport | null
): ProcessMetricReport | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return combineProcessMetrics(left, right);
}

function combineProcessMetrics(
  left: ProcessMetricReport,
  right: ProcessMetricReport
): ProcessMetricReport {
  if (left.kind !== right.kind) {
    throw new Error("Profile process metric kinds diverged.");
  }
  return {
    cpuSystemTicks: left.cpuSystemTicks + right.cpuSystemTicks,
    cpuUserTicks: left.cpuUserTicks + right.cpuUserTicks,
    kind: left.kind,
    maxRssBytes: Math.max(left.maxRssBytes, right.maxRssBytes),
    openFiles: Math.max(left.openFiles, right.openFiles),
  };
}

function requestFetcher(baseUrl: string) {
  return async (
    request: ProfileRequest,
    signal: AbortSignal
  ): Promise<RequestObservation> => {
    const response = await fetch(
      `${baseUrl}/?object=${encodeURIComponent(request.objectName)}`,
      {
        body: JSON.stringify({ text: `profile-${request.index}` }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      }
    );
    const payload: unknown = await response.json();
    return {
      correct:
        response.ok &&
        typeof payload === "object" &&
        payload !== null &&
        "ok" in payload &&
        payload.ok === true,
    };
  };
}
