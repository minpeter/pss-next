import { execFile as execFileCallback, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const CELLD = process.env.CELLD_BIN ?? `${process.env.HOME}/.local/bin/celld`;
const ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:14566";
const BUCKET = process.env.CELLD_QA_BUCKET ?? "pss-celld-qa";
const ESBUILD =
  process.env.CELLD_ESBUILD ??
  resolve(
    import.meta.dirname,
    "../../../node_modules/.pnpm/@esbuild+linux-x64@0.28.2/node_modules/@esbuild/linux-x64/bin/esbuild"
  );

export type CelldSurface = "native" | "container";

export async function createBucket(): Promise<void> {
  const response = await fetch(`${ENDPOINT}/${BUCKET}`, { method: "PUT" });
  if (!(response.ok || response.status === 409)) {
    throw new Error(`bucket creation failed: ${response.status}`);
  }
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
    { env: { ...process.env, CELLD_ESBUILD: ESBUILD, TMPDIR: "/var/tmp" } }
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
      env: { ...process.env, CELLD_WATCH: watch, TMPDIR: "/var/tmp" },
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
      "AWS_ACCESS_KEY_ID=test",
      "-e",
      "AWS_SECRET_ACCESS_KEY=test",
      "-e",
      `S3_ENDPOINT=${ENDPOINT}`,
      "-e",
      `CELLD_WATCH=${watch}`,
      "-e",
      "TMPDIR=/var/tmp",
      "ghcr.io/denoland/celld:v0.3.0",
      ...args,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

export function waitForListening(
  child: ReturnType<typeof spawn>
): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const onData = (chunk: Buffer): void => {
      if (chunk.toString("utf8").includes("celld listening on")) {
        child.stdout?.off("data", onData);
        resolveReady();
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Celld exited before readiness: ${code}`))
    );
  });
}

export async function stopCelld(
  child: ReturnType<typeof spawn>
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolveExit) =>
    child.once("exit", () => resolveExit())
  );
  child.kill("SIGTERM");
  await exited;
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
  await waitForListening(restarted);
  return restarted;
}
