import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createBucket,
  deploy,
  startCelld,
  stopCelld,
  waitForListening,
} from "./celld-process";
import { runMatrix } from "./qa-matrix";

interface LoadOptions {
  readonly baseUrl: string;
  readonly concurrency: number;
  readonly objectCount: number;
  readonly output?: string;
}

interface CliOptions {
  readonly concurrency: number;
  readonly objectCount: number;
  readonly output?: string;
  readonly port: number;
}

interface LoadReport {
  readonly elapsedMs: number;
  readonly errors: number;
  readonly openFiles: number;
  readonly result: Awaited<ReturnType<typeof runMatrix>>;
  readonly runnerCpuUserUs: number;
  readonly surface: "native";
}

export async function runLoad({
  baseUrl,
  concurrency,
  objectCount,
  output,
}: LoadOptions): Promise<LoadReport> {
  const started = performance.now();
  let result: Awaited<ReturnType<typeof runMatrix>>;
  try {
    result = await runMatrix({ baseUrl, concurrency, objectCount });
  } catch (error) {
    if (output !== undefined) {
      await writeFile(
        output,
        `${JSON.stringify({ errors: 1, message: String(error) })}\n`,
        "utf8"
      );
    }
    throw error;
  }
  const report: LoadReport = {
    elapsedMs: performance.now() - started,
    errors: 0,
    openFiles: 0,
    result,
    runnerCpuUserUs: process.resourceUsage().userCPUTime,
    surface: "native",
  };
  if (output !== undefined) {
    await writeFile(output, `${JSON.stringify(report)}\n`, "utf8");
  }
  return report;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runId = randomUUID().slice(0, 8);
  const watch = await mkdtemp(join("/var/tmp", `pss-celld-load-${runId}-`));
  const prefix = `load-${runId}`;
  await createBucket();
  await deploy(prefix);
  const child = startCelld("native", prefix, options.port, watch);
  try {
    await waitForListening(child);
    const report = await runLoad({
      baseUrl: `http://127.0.0.1:${options.port}`,
      concurrency: options.concurrency,
      objectCount: options.objectCount,
      output: options.output,
    });
    console.log(JSON.stringify({ ...report, ok: true }));
  } finally {
    await stopCelld(child);
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
      throw new Error("Usage: qa:load --objects <n> --concurrency <n>");
    }
    values.set(key, value);
  }
  const concurrency = Number(values.get("--concurrency") ?? "64");
  const objectCount = Number(values.get("--objects") ?? "100");
  const port = Number(values.get("--port") ?? "16423");
  const output = values.get("--output");
  if (
    ![concurrency, objectCount, port].every(
      (value) => Number.isInteger(value) && value > 0
    )
  ) {
    throw new Error("Invalid load arguments.");
  }
  return { concurrency, objectCount, port, output };
}

if (import.meta.main) {
  await main();
}
