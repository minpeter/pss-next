import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import { Socket } from "node:net";
import { promisify } from "node:util";
import type { CleanupRemaining } from "./campaign-cleanup";

const execFile = promisify(execFileCallback);

export interface CleanupResourceScope {
  readonly containerNames: readonly string[];
  readonly pids: readonly number[];
  readonly ports: readonly number[];
  readonly prefixObjectChecks: readonly (() => Promise<number>)[];
  readonly proxyFaultChecks: readonly (() => Promise<number>)[];
  readonly watchPaths: readonly string[];
}

export interface CleanupProbes {
  readonly isContainerPresent: (name: string) => Promise<boolean>;
  readonly isPathPresent: (path: string) => Promise<boolean>;
  readonly isPidAlive: (pid: number) => boolean;
  readonly isPortOpen: (port: number) => Promise<boolean>;
}

const defaultProbes: CleanupProbes = {
  isContainerPresent,
  isPathPresent,
  isPidAlive,
  isPortOpen,
};

export async function measureCleanupRemaining(
  scope: CleanupResourceScope,
  probes: CleanupProbes = defaultProbes
): Promise<CleanupRemaining> {
  const [containers, ports, prefixObjects, proxyFaults, watchPaths] =
    await Promise.all([
      countTruthy(scope.containerNames, probes.isContainerPresent),
      countTruthy(scope.ports, probes.isPortOpen),
      sumChecks(scope.prefixObjectChecks),
      sumChecks(scope.proxyFaultChecks),
      countTruthy(scope.watchPaths, probes.isPathPresent),
    ]);
  return {
    containers,
    ports,
    prefixObjects,
    processes: scope.pids.filter(probes.isPidAlive).length,
    proxyFaults,
    watchPaths,
  };
}

async function sumChecks(
  checks: readonly (() => Promise<number>)[]
): Promise<number> {
  const counts = await Promise.all(checks.map((check) => check()));
  return counts.reduce((sum, value) => sum + value, 0);
}

async function countTruthy<T>(
  values: readonly T[],
  predicate: (value: T) => Promise<boolean>
): Promise<number> {
  const results = await Promise.all(values.map(predicate));
  return results.filter(Boolean).length;
}

async function isContainerPresent(name: string): Promise<boolean> {
  try {
    await execFile("docker", ["inspect", name]);
    return true;
  } catch (error) {
    if (hasNumericCode(error) && error.code === 1) {
      return false;
    }
    throw error;
  }
}

async function isPathPresent(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (hasStringCode(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasStringCode(error) && error.code === "ESRCH") {
      return false;
    }
    if (hasStringCode(error) && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const signal = AbortSignal.timeout(1000);
    const settle = (open: boolean): void => {
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    const onAbort = (): void => settle(false);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.connect({ host: "127.0.0.1", port });
  });
}

function hasNumericCode(value: unknown): value is { readonly code: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number"
  );
}

function hasStringCode(value: unknown): value is { readonly code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string"
  );
}
