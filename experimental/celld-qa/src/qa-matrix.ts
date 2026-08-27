import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  createBucket,
  deploy,
  restartCelld,
  startCelld,
  stopCelld,
  waitForListening,
} from "./celld-process";

interface MatrixOptions {
  readonly baseUrl: string;
  readonly concurrency: number;
  readonly fetchImpl?: typeof fetch;
  readonly objectCount: number;
  readonly restartPreserved?: boolean;
}

export interface MatrixResult {
  readonly concurrentObjects: number;
  readonly duplicateCommits: 1;
  readonly malformedStatus: 400;
  readonly restartPreserved: boolean;
}

export async function runMatrix({
  baseUrl,
  concurrency,
  fetchImpl = fetch,
  objectCount,
  restartPreserved = false,
}: MatrixOptions): Promise<MatrixResult> {
  if (!(Number.isInteger(objectCount) && objectCount > 0)) {
    throw new Error("objectCount must be positive.");
  }
  if (!(Number.isInteger(concurrency) && concurrency > 0)) {
    throw new Error("concurrency must be positive.");
  }
  const malformed = await fetchImpl(baseUrl, {
    body: "{",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (malformed.status !== 400) {
    throw new Error(`malformed input returned ${malformed.status}`);
  }

  const duplicateKey = `duplicate-${Date.now()}`;
  const duplicate = await Promise.all([
    call(fetchImpl, baseUrl, "duplicate-object", duplicateKey),
    call(fetchImpl, baseUrl, "duplicate-object", duplicateKey),
  ]);
  if (
    duplicate[0]?.historyCount !== duplicate[1]?.historyCount ||
    duplicate[0]?.reply !== duplicate[1]?.reply
  ) {
    throw new Error("duplicate idempotency did not converge");
  }

  const objects = Array.from({ length: objectCount }, (_, index) => index);
  const responses: { readonly reply: string }[] = [];
  for (let offset = 0; offset < objects.length; offset += concurrency) {
    const batch = objects.slice(offset, offset + concurrency);
    responses.push(
      ...(await Promise.all(
        batch.map((index) => call(fetchImpl, baseUrl, `object-${index}`))
      ))
    );
  }
  return {
    concurrentObjects: responses.length,
    duplicateCommits: 1,
    malformedStatus: 400,
    restartPreserved,
  };
}

interface CliOptions {
  readonly concurrency: number;
  readonly containerPort: number;
  readonly nativePort: number;
  readonly objectCount: number;
  readonly report?: string;
}

interface SurfaceReport extends MatrixResult {
  readonly port: number;
  readonly surface: "container" | "native";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const reports: SurfaceReport[] = [];
  for (const surface of [
    { kind: "native" as const, port: options.nativePort },
    { kind: "container" as const, port: options.containerPort },
  ]) {
    const prefix = `matrix-${surface.kind}-${randomUUID().slice(0, 8)}`;
    const watch = `/var/tmp/pss-celld-${surface.kind}-${randomUUID()}`;
    await createBucket();
    await deploy(prefix);
    let child = startCelld(surface.kind, prefix, surface.port, watch);
    try {
      await waitForListening(child);
      const beforeRestart = await call(
        fetch,
        `http://127.0.0.1:${surface.port}`,
        "restart-object"
      );
      if (beforeRestart.historyCount !== 1) {
        throw new Error("restart probe did not start at count one");
      }
      child = await restartCelld(
        surface.kind,
        prefix,
        surface.port,
        watch,
        child
      );
      const afterRestart = await call(
        fetch,
        `http://127.0.0.1:${surface.port}`,
        "restart-object"
      );
      if (afterRestart.historyCount !== 2) {
        throw new Error("restart probe did not preserve state");
      }
      const report = await runMatrix({
        baseUrl: `http://127.0.0.1:${surface.port}`,
        concurrency: options.concurrency,
        objectCount: options.objectCount,
        restartPreserved: true,
      });
      reports.push({ ...report, port: surface.port, surface: surface.kind });
    } finally {
      await stopCelld(child);
    }
  }
  const output = { ok: true, reports, surface: "matrix" };
  if (options.report !== undefined) {
    await writeFile(options.report, `${JSON.stringify(output)}\n`, "utf8");
  }
  console.log(JSON.stringify(output));
}

function parseArgs(argv: readonly string[]): CliOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined) {
      throw new Error(
        "Usage: qa:matrix --native-port <port> --container-port <port>"
      );
    }
    values.set(key, value);
  }
  const nativePort = Number(values.get("--native-port") ?? "16421");
  const containerPort = Number(values.get("--container-port") ?? "16422");
  const objectCount = Number(values.get("--objects") ?? "25");
  const concurrency = Number(values.get("--concurrency") ?? "64");
  const report = values.get("--report");
  if (
    ![nativePort, containerPort, objectCount, concurrency].every(
      (value) => Number.isInteger(value) && value > 0
    )
  ) {
    throw new Error("Invalid matrix arguments.");
  }
  return { concurrency, containerPort, nativePort, objectCount, report };
}

async function call(
  fetchImpl: typeof fetch,
  baseUrl: string,
  objectName: string,
  idempotencyKey?: string
): Promise<{ readonly historyCount: number; readonly reply: string }> {
  const response = await fetchImpl(
    `${baseUrl}/?object=${encodeURIComponent(objectName)}`,
    {
      body: JSON.stringify({
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        text: "hello",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  const payload: unknown = await response.json();
  if (
    !response.ok ||
    typeof payload !== "object" ||
    payload === null ||
    !("historyCount" in payload) ||
    typeof payload.historyCount !== "number" ||
    !("reply" in payload) ||
    typeof payload.reply !== "string"
  ) {
    throw new Error(`matrix call failed: ${response.status}`);
  }
  return { historyCount: payload.historyCount, reply: payload.reply };
}

if (import.meta.main) {
  await main();
}
