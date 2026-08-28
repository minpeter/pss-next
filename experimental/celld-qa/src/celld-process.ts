import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { assertLoopbackEndpoint } from "./celld-bucket";
import {
  celldProcessConfiguration,
  localEnvironment,
} from "./celld-process-config";
import type { CelldChild, CelldSurface } from "./celld-process-lifecycle";
import {
  restartCelld as restartCelldLifecycle,
  startCelld as startCelldLifecycle,
  stopCelld as stopCelldLifecycle,
  waitForListening as waitForListeningLifecycle,
} from "./celld-process-lifecycle";
import type { CelldProcessMetrics } from "./celld-process-metrics";
import { readProcessMetrics as readProcessMetricsValue } from "./celld-process-metrics";

const execFile = promisify(execFileCallback);

export type {
  CelldChild,
  CelldSurface,
} from "./celld-process-lifecycle";
export type { CelldProcessMetrics } from "./celld-process-metrics";

export function startCelld(
  surface: CelldSurface,
  prefix: string,
  port: number,
  watch: string
): CelldChild {
  return startCelldLifecycle(surface, prefix, port, watch);
}

export function waitForListening(child: CelldChild): Promise<void> {
  return waitForListeningLifecycle(child);
}

export function stopCelld(child: CelldChild): Promise<void> {
  return stopCelldLifecycle(child);
}

export function restartCelld(
  surface: CelldSurface,
  prefix: string,
  port: number,
  watch: string,
  child: CelldChild
): Promise<CelldChild> {
  return restartCelldLifecycle(surface, prefix, port, watch, child);
}

export function readProcessMetrics(
  pid: number | undefined
): Promise<CelldProcessMetrics> {
  return readProcessMetricsValue(pid);
}

export async function createBucket(): Promise<void> {
  const configuration = celldProcessConfiguration();
  assertLoopbackEndpoint(configuration.endpoint);
  const response = await fetch(
    `${configuration.endpoint}/${configuration.bucket}`,
    { method: "PUT" }
  );
  if (!(response.ok || response.status === 409)) {
    throw new Error(`bucket creation failed: ${response.status}`);
  }
  await execFile(
    configuration.celld,
    [
      "diagnose",
      "--bucket",
      `s3://${configuration.bucket}`,
      "--endpoint",
      configuration.endpoint,
      "--region",
      "us-east-1",
      "--listen",
      "127.0.0.1:0",
      "--internal-listen",
      "127.0.0.1:0",
    ],
    { env: localEnvironment() }
  );
}

export async function deploy(prefix: string): Promise<void> {
  const configuration = celldProcessConfiguration();
  if (!existsSync(configuration.esbuild)) {
    throw new Error(`esbuild not found: ${configuration.esbuild}`);
  }
  await execFile(
    configuration.celld,
    [
      "deploy",
      resolve(import.meta.dirname, "../worker"),
      "--bucket",
      `s3://${configuration.bucket}/${prefix}`,
      "--endpoint",
      configuration.endpoint,
      "--region",
      "us-east-1",
    ],
    {
      env: {
        ...localEnvironment(),
        CELLD_ESBUILD: configuration.esbuild,
        TMPDIR: "/var/tmp",
      },
    }
  );
}
