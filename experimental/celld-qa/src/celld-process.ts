import { execFile as execFileCallback, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const RSS_PATTERN = /^VmRSS:\s+(\d+)\s+kB$/m;
const CELLD = process.env.CELLD_BIN ?? `${process.env.HOME}/.local/bin/celld`;
const ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:14566";
const BUCKET = process.env.CELLD_QA_BUCKET ?? "pss-celld-qa";
const LIFECYCLE_TIMEOUT_MS = 30_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ESBUILD =
  process.env.CELLD_ESBUILD ??
  resolve(
    import.meta.dirname,
    "../../../node_modules/.pnpm/@esbuild+linux-x64@0.28.2/node_modules/@esbuild/linux-x64/bin/esbuild"
  );

export type CelldSurface = "native" | "container";

export interface CelldProcessMetrics {
  readonly cpuSystemTicks: number;
  readonly cpuUserTicks: number;
  readonly maxRssBytes: number;
  readonly openFiles: number;
}

export async function readProcessMetrics(
  pid: number | undefined
): Promise<CelldProcessMetrics> {
  if (pid === undefined) {
    return { cpuSystemTicks: 0, cpuUserTicks: 0, maxRssBytes: 0, openFiles: 0 };
  }
  const [status, stat, fds] = await Promise.all([
    readFile(`/proc/${pid}/status`, "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
    readdir(`/proc/${pid}/fd`),
  ]);
  const rss = RSS_PATTERN.exec(status);
  const fields = stat.slice(stat.indexOf(")") + 2).split(" ");
  return {
    cpuSystemTicks: Number(fields[12] ?? 0),
    cpuUserTicks: Number(fields[11] ?? 0),
    maxRssBytes: Number(rss?.[1] ?? 0) * 1024,
    openFiles: fds.length,
  };
}

export async function createBucket(): Promise<void> {
  const endpoint = new URL(ENDPOINT);
  if (!LOCAL_HOSTS.has(endpoint.hostname)) {
    throw new Error(`Celld QA endpoint must be loopback: ${endpoint.hostname}`);
  }
  const response = await fetch(`${ENDPOINT}/${BUCKET}`, { method: "PUT" });
  if (!(response.ok || response.status === 409)) {
    throw new Error(`bucket creation failed: ${response.status}`);
  }
  await execFile(
    CELLD,
    [
      "diagnose",
      "--bucket",
      `s3://${BUCKET}`,
      "--endpoint",
      ENDPOINT,
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
  if (!existsSync(ESBUILD)) {
    throw new Error(`esbuild not found: ${ESBUILD}`);
  }
  await execFile(
    CELLD,
    [
      "deploy",
      resolve(import.meta.dirname, "../worker"),
      "--bucket",
      `s3://${BUCKET}/${prefix}`,
      "--endpoint",
      ENDPOINT,
      "--region",
      "us-east-1",
    ],
    {
      env: {
        ...localEnvironment(),
        CELLD_ESBUILD: ESBUILD,
        TMPDIR: "/var/tmp",
      },
    }
  );
}

export function startCelld(
  surface: CelldSurface,
  prefix: string,
  port: number,
  watch: string
): ReturnType<typeof spawn> {
  const args = [
    "--bucket",
    `s3://${BUCKET}/${prefix}`,
    "--endpoint",
    ENDPOINT,
    "--region",
    "us-east-1",
    "--listen",
    `127.0.0.1:${port}`,
    "--internal-listen",
    "127.0.0.1:0",
  ];
  if (surface === "native") {
    return spawn(CELLD, args, {
      env: {
        ...localEnvironment(),
        CELLD_WATCH: watch,
        TMPDIR: "/var/tmp",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "host",
      "--name",
      `pss-celld-${surface}-${port}`,
      "-e",
      `AWS_ACCESS_KEY_ID=${localEnvironment().AWS_ACCESS_KEY_ID}`,
      "-e",
      `AWS_SECRET_ACCESS_KEY=${localEnvironment().AWS_SECRET_ACCESS_KEY}`,
      "-e",
      `S3_ENDPOINT=${ENDPOINT}`,
      "-e",
      `CELLD_WATCH=${watch}`,
      "-e",
      "TMPDIR=/var/tmp",
      "ghcr.io/denoland/celld:v0.3.0",
      ...args,
    ],
    {
      env: localEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

export function waitForListening(
  child: ReturnType<typeof spawn>
): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Celld readiness timed out"));
    }, LIFECYCLE_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer): void => {
      if (chunk.toString("utf8").includes("celld listening on")) {
        cleanup();
        resolveReady();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Celld exited before readiness: ${code}`));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", () => undefined);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function stopCelld(
  child: ReturnType<typeof spawn>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  if (await waitForExit(child)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await waitForExit(child))) {
    throw new Error("Celld shutdown timed out after SIGKILL");
  }
}

export async function restartCelld(
  surface: CelldSurface,
  prefix: string,
  port: number,
  watch: string,
  child: ReturnType<typeof spawn>
): Promise<ReturnType<typeof spawn>> {
  await stopCelld(child);
  const restarted = startCelld(surface, prefix, port, watch);
  try {
    await waitForListening(restarted);
    return restarted;
  } catch (error) {
    await stopCelld(restarted);
    throw error;
  }
}

function localEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, LIFECYCLE_TIMEOUT_MS);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}
