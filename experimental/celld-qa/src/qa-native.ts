import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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

interface QaOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly objectName: string;
  readonly text: string;
}

interface EchoResult {
  readonly historyCount: number;
  readonly ok: true;
  readonly reply: string;
}

export async function runNativeQa({
  baseUrl,
  fetchImpl,
  objectName,
  text,
}: QaOptions): Promise<{
  readonly first: EchoResult;
  readonly second: EchoResult;
}> {
  const first = await callEcho(baseUrl, objectName, text, fetchImpl);
  const second = await callEcho(baseUrl, objectName, text, fetchImpl);
  if (first.historyCount !== 1 || second.historyCount !== 2) {
    throw new Error(
      `unexpected persistent counts: ${first.historyCount}, ${second.historyCount}`
    );
  }
  return { first, second };
}

async function callEcho(
  baseUrl: string,
  objectName: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<EchoResult> {
  const response = await fetchImpl(
    `${baseUrl}/?object=${encodeURIComponent(objectName)}`,
    {
      body: JSON.stringify({ text }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  const value: unknown = await response.json();
  if (
    !response.ok ||
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    value.ok !== true ||
    !("reply" in value) ||
    typeof value.reply !== "string" ||
    !("historyCount" in value) ||
    typeof value.historyCount !== "number"
  ) {
    throw new Error(`Celld echo failed: ${response.status}`);
  }
  return {
    historyCount: value.historyCount,
    ok: true,
    reply: value.reply,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const port = options.port;
  const runId = randomUUID().slice(0, 8);
  const prefix = `qa-${runId}`;
  const watch = await mkdtemp(join("/var/tmp", "pss-celld-qa-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await createBucket();
    await deploy(prefix);
    child = spawnCelld(prefix, port, watch);
    await waitForListening(child);
    const result = await runNativeQa({
      baseUrl: `http://127.0.0.1:${port}`,
      objectName: options.objectName,
      text: options.text,
    });
    console.log(JSON.stringify({ ...result, ok: true, surface: "native" }));
  } finally {
    if (child !== undefined) {
      await stop(child);
    }
    await rm(watch, { force: true, recursive: true });
  }
}

function parseArgs(argv: readonly string[]): {
  readonly objectName: string;
  readonly port: number;
  readonly text: string;
} {
  const values = new Map<string, string>();
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined) {
      throw new Error(
        "Usage: qa:native --port <port> --object <name> --text <text>"
      );
    }
    values.set(key, value);
  }
  const port = Number(values.get("--port") ?? "16420");
  const objectName = values.get("--object") ?? "pss-smoke";
  const text = values.get("--text") ?? "hello";
  if (
    !(Number.isInteger(port) && port > 0 && port < 65_536 && text.length > 0)
  ) {
    throw new Error("Invalid native QA arguments.");
  }
  return { objectName, port, text };
}

async function createBucket(): Promise<void> {
  const response = await fetch(`${ENDPOINT}/${BUCKET}`, { method: "PUT" });
  if (!(response.ok || response.status === 409)) {
    throw new Error(`bucket creation failed: ${response.status}`);
  }
}

async function deploy(prefix: string): Promise<void> {
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
      env: { ...process.env, CELLD_ESBUILD: ESBUILD, TMPDIR: "/var/tmp" },
    }
  );
}

function spawnCelld(
  prefix: string,
  port: number,
  watch: string
): ReturnType<typeof spawn> {
  return spawn(
    CELLD,
    [
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
    ],
    {
      env: { ...process.env, CELLD_WATCH: watch },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

function waitForListening(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const onData = (chunk: Buffer): void => {
      if (chunk.toString("utf8").includes("celld listening on")) {
        child.stdout?.off("data", onData);
        resolveReady();
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`Celld exited before readiness: ${code}`));
    });
  });
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolveExit) =>
    child.once("exit", () => resolveExit())
  );
  child.kill("SIGTERM");
  await exited;
}

if (import.meta.main) {
  await main();
}
