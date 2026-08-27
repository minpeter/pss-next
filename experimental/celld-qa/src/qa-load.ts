import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { runMatrix } from "./qa-matrix";

interface LoadOptions {
  readonly baseUrl: string;
  readonly concurrency: number;
  readonly objectCount: number;
  readonly output?: string;
}

export async function runLoad({
  baseUrl,
  concurrency,
  objectCount,
  output,
}: LoadOptions): Promise<{
  readonly elapsedMs: number;
  readonly errors: number;
  readonly result: Awaited<ReturnType<typeof runMatrix>>;
}> {
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
  const report = {
    elapsedMs: performance.now() - started,
    errors: 0,
    result,
  };
  if (output !== undefined) {
    await writeFile(output, `${JSON.stringify(report)}\n`, "utf8");
  }
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const baseUrl = args[0] ?? "http://127.0.0.1:16421";
  const objectCount = Number(args[1] ?? "100");
  const concurrency = Number(args[2] ?? "64");
  await runLoad({ baseUrl, concurrency, objectCount }).then((report) => {
    console.log(JSON.stringify({ ...report, ok: true, surface: "load" }));
  });
}
