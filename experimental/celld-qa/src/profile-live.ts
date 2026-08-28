import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { requireMeasuredCleanupPassed } from "./campaign-cleanup";
import { runWithCampaignCleanup } from "./campaign-lifecycle";
import {
  type CelldChild,
  createBucket,
  deploy,
  readProcessMetrics,
  restartCelld,
  startCelld,
  waitForListening,
} from "./celld-process";
import { observeCelldExit } from "./celld-process-output";
import {
  mergeProcessMetrics,
  type ProcessMetricReport,
  type ProcessObservation,
} from "./process-observer";
import { cleanupLiveProfile, recordOwnedPid } from "./profile-cleanup";
import { mergeRecentLatencySamples } from "./profile-latency-samples";
import { PROFILE_PLANS } from "./profile-plans";
import { isCorrectProfileResponse } from "./profile-response";
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
  readonly cleanupPassed: boolean;
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
  let cleanupPassed: boolean | undefined;
  const ownedPids: number[] = [];
  const cleanup = async (): Promise<void> => {
    cleanupPassed = await cleanupLiveProfile({
      child,
      cleanupPath,
      ownedPids,
      port: options.port,
      prefix,
      runId,
      watch,
    });
    child = undefined;
  };
  const report = await runWithCampaignCleanup({
    cleanup,
    run: async () => {
      await createBucket();
      await deploy(prefix);
      child = startCelld("native", prefix, options.port, watch);
      recordOwnedPid(child, ownedPids);
      if (options.profile === "restart") {
        await waitForListening(child);
        const result = await runChurnProfile(
          options,
          prefix,
          watch,
          child,
          (next) => {
            child = next;
            recordOwnedPid(next, ownedPids);
          }
        );
        return result.report;
      }
      return runObservedFiniteProfile(options, child);
    },
  });
  return {
    cleanupPassed: requireMeasuredCleanupPassed(cleanupPassed, "Profile"),
    cleanupPath,
    report,
    runId,
  };
}

function runFiniteProfile(
  options: LiveProfileOptions,
  pid: number | undefined,
  signal?: AbortSignal
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
            await writeFile(progressPath, line, { flag: "a" });
          },
    signal,
  });
}

async function runObservedFiniteProfile(
  options: LiveProfileOptions,
  child: CelldChild
): Promise<ProfileReport> {
  const controller = new AbortController();
  const observer = observeCelldExit(child);
  const exit = observer.exit.catch((error: unknown) => {
    controller.abort(error);
    throw error;
  });
  try {
    await Promise.race([waitForListening(child), exit]);
    return await Promise.race([
      runFiniteProfile(options, child.pid ?? undefined, controller.signal),
      exit,
    ]);
  } finally {
    observer.dispose();
  }
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
  let runnerCpuSystemMicros = 0;
  let runnerCpuUserMicros = 0;
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
          ...plan,
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
      samples = mergeRecentLatencySamples(samples, batch.latencySamples);
      processMetrics = mergeProcessMetrics(
        processMetrics,
        batch.processMetrics
      );
      runnerCpuSystemMicros += batch.runnerMetrics.cpuSystemMicros;
      runnerCpuUserMicros += batch.runnerMetrics.cpuUserMicros;
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
      runnerMetrics: {
        cpuSystemMicros: runnerCpuSystemMicros,
        cpuUserMicros: runnerCpuUserMicros,
        throughputPerSecond:
          elapsedMs === 0 ? null : (totalCompleted * 1000) / elapsedMs,
      },
    },
  };
}

function requestFetcher(baseUrl: string) {
  return async (
    request: ProfileRequest,
    signal: AbortSignal
  ): Promise<RequestObservation> => {
    const text = `profile-${request.index}`;
    const response = await fetch(
      `${baseUrl}/?object=${encodeURIComponent(request.objectName)}`,
      {
        body: JSON.stringify({ text }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      }
    );
    const payload: unknown = await response.json();
    return {
      correct: response.ok && isCorrectProfileResponse(payload, text),
    };
  };
}
