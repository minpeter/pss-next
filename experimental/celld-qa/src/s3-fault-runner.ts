import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CleanupRemaining } from "./campaign-cleanup";
import { runWithCampaignCleanup } from "./campaign-lifecycle";
import { cleanupPrefix } from "./celld-bucket";
import {
  type CelldChild,
  createBucket,
  deploy,
  restartCelld,
  startCelld,
  stopCelld,
  waitForListening,
} from "./celld-process";
import { celldProcessConfiguration } from "./celld-process-config";
import { FaultProxyControlClient } from "./fault-proxy-control-client";
import {
  BoundaryInputError,
  FAULT_KINDS,
  type FaultKind,
  requireLoopbackUrl,
  type S3FaultReport,
  type ScenarioResult,
} from "./fault-proxy-types";
import { measureS3Cleanup } from "./s3-fault-cleanup";
import {
  type FaultScenarioRuntime,
  runFaultScenario,
} from "./s3-fault-scenario";
import { faultRule, requestFaultWorker } from "./s3-fault-worker";
import { startLocalStack, stopLocalStack } from "./s3-localstack";
import { ToxiproxyClient } from "./toxiproxy-client";

export interface LiveCampaignOptions {
  readonly controlUrl: string;
  readonly port: number;
  readonly proxyUrl: string;
  readonly s3Url: string;
  readonly toxiproxyUrl: string;
}

export interface LiveS3FaultCampaignResult {
  readonly cleanup: CleanupRemaining;
  readonly report: S3FaultReport;
  readonly runId: string;
}

interface LiveContext {
  readonly control: FaultProxyControlClient;
  readonly keyPattern: string;
  readonly objectPrefix: string;
  readonly proxyName: string;
  readonly toxiproxy: ToxiproxyClient;
  readonly workerUrl: URL;
}

export async function runS3FaultCampaign(
  runScenario: (kind: FaultKind) => Promise<ScenarioResult>
): Promise<S3FaultReport> {
  const scenarios: ScenarioResult[] = [];
  for (const kind of FAULT_KINDS) {
    const result = await runScenario(kind);
    if (result.kind !== kind) {
      throw new BoundaryInputError(
        `scenario returned ${result.kind}, expected ${kind}`
      );
    }
    scenarios.push(Object.freeze({ ...result }));
  }
  return Object.freeze({
    ok: scenarios.every(
      (scenario) =>
        scenario.observed &&
        scenario.injectionEvidence &&
        scenario.recovery &&
        scenario.convergence &&
        scenario.effect === "exactly_once"
    ),
    scenarios: Object.freeze(scenarios),
  });
}

export async function runLiveS3FaultCampaign(
  options: LiveCampaignOptions
): Promise<LiveS3FaultCampaignResult> {
  const proxyUrl = requireLoopbackUrl(
    options.proxyUrl,
    "fault proxy data endpoint"
  );
  const workerUrl = requireLoopbackUrl(
    `http://127.0.0.1:${options.port}`,
    "Celld worker endpoint"
  );
  const directS3Url = requireLoopbackUrl(options.s3Url, "LocalStack endpoint");
  const runId = randomUUID();
  const prefix = `campaign-s3-fault-${runId}`;
  const watch = await mkdtemp(join("/var/tmp", "pss-celld-s3-fault-"));
  const configuration = celldProcessConfiguration();
  const proxyName = `s3-loopback-${runId.slice(0, 12)}`;
  const control = new FaultProxyControlClient(options.controlUrl);
  const toxiproxy = new ToxiproxyClient(options.toxiproxyUrl);
  const previousEndpoint = process.env.S3_ENDPOINT;
  let child: CelldChild | undefined;
  let cleanupRemaining: CleanupRemaining | undefined;
  let localStackStopped = false;
  const ownedPids: number[] = [];
  const context: LiveContext = {
    control,
    keyPattern: `/${configuration.bucket}/${prefix}/*`,
    objectPrefix: `s3-fault-${runId}`,
    proxyName,
    toxiproxy,
    workerUrl,
  };
  const cleanup = async (): Promise<void> => {
    try {
      if (child !== undefined) {
        await stopCelld(child);
        child = undefined;
      }
      if (localStackStopped) {
        await startLocalStack();
        await createBucket();
        localStackStopped = false;
      }
      await control.install({ kind: "pass" });
      await toxiproxy.clearToxics(proxyName);
      await cleanupPrefix(prefix, { endpoint: proxyUrl.origin });
      await rm(watch, { force: true, recursive: true });
      await toxiproxy.deleteProxy(proxyName);
    } finally {
      restoreEndpoint(previousEndpoint);
    }
    cleanupRemaining = await measureS3Cleanup({
      control,
      endpoint: directS3Url.origin,
      ownedPids,
      port: options.port,
      prefix,
      proxyName,
      toxiproxy,
      watch,
    });
  };
  const report = await runWithCampaignCleanup({
    cleanup,
    run: async () => {
      await toxiproxy.deleteProxiesListeningOn(8666);
      await toxiproxy.createProxy({
        listen: "0.0.0.0:8666",
        name: proxyName,
        upstream: "localstack:4566",
      });
      process.env.S3_ENDPOINT = proxyUrl.origin;
      await control.install({ kind: "pass" });
      await createBucket();
      await deploy(prefix);
      child = startCelld("native", prefix, options.port, watch);
      registerPid(child, ownedPids);
      await waitForListening(child);
      return await runS3FaultCampaign((kind) =>
        runFaultScenario(kind, {
          activate: async (faultKind) => {
            if (faultKind === "localstack_restart") {
              localStackStopped = true;
            }
            return await activateFault(faultKind, context);
          },
          deactivate: async (faultKind) => {
            if (faultKind === "localstack_restart") {
              await startLocalStack();
              await createBucket();
              await deploy(prefix);
              child = await restartCelld(
                "native",
                prefix,
                options.port,
                watch,
                requireChild(child)
              );
              registerPid(child, ownedPids);
              localStackStopped = false;
            }
            await clearFault(context);
          },
          events: () => context.control.events(),
          request: (faultKind) => requestFaultWorker(context, faultKind),
        } satisfies FaultScenarioRuntime)
      );
    },
  });
  return {
    cleanup: requireCleanupRemaining(cleanupRemaining),
    report,
    runId,
  };
}

async function activateFault(
  kind: FaultKind,
  context: LiveContext
): Promise<number> {
  await clearFault(context);
  const generation = await context.control.install(
    faultRule(kind, context.keyPattern)
  );
  if (kind === "latency") {
    await context.toxiproxy.addLatency(context.proxyName, 125);
  } else if (kind === "timeout") {
    await context.toxiproxy.addTimeout(context.proxyName, 50);
  } else if (kind === "reset") {
    await context.toxiproxy.addReset(context.proxyName);
  } else if (kind === "localstack_restart") {
    await stopLocalStack();
  }
  return generation.id;
}

async function clearFault(context: LiveContext): Promise<void> {
  await context.toxiproxy.clearToxics(context.proxyName);
  await context.control.install({ kind: "pass" });
}

function restoreEndpoint(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.S3_ENDPOINT;
  } else {
    process.env.S3_ENDPOINT = value;
  }
}

function requireChild(child: CelldChild | undefined): CelldChild {
  if (child === undefined) {
    throw new Error("Celld child is unavailable during S3 recovery.");
  }
  return child;
}

function registerPid(child: CelldChild, ownedPids: number[]): void {
  if (child.pid !== undefined) {
    ownedPids.push(child.pid);
  }
}

function requireCleanupRemaining(
  value: CleanupRemaining | undefined
): CleanupRemaining {
  if (value === undefined) {
    throw new Error("S3 cleanup measurement was not produced.");
  }
  return value;
}
