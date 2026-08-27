import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createBucket,
  deploy,
  startCelld,
  stopCelld,
  waitForListening,
} from "./celld-process";

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

interface CliOptions {
  readonly objectName: string;
  readonly port: number;
  readonly text: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runId = randomUUID().slice(0, 8);
  const prefix = `qa-${runId}`;
  const watch = await mkdtemp(join("/var/tmp", "pss-celld-qa-"));
  let child: ReturnType<typeof startCelld> | undefined;
  try {
    await createBucket();
    await deploy(prefix);
    child = startCelld("native", prefix, options.port, watch);
    await waitForListening(child);
    const result = await runNativeQa({
      baseUrl: `http://127.0.0.1:${options.port}`,
      objectName: options.objectName,
      text: options.text,
    });
    console.log(JSON.stringify({ ...result, ok: true, surface: "native" }));
  } finally {
    if (child !== undefined) {
      await stopCelld(child);
    }
    await rm(watch, { force: true, recursive: true });
  }
}

function parseArgs(argv: readonly string[]): CliOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
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

if (import.meta.main) {
  await main();
}
