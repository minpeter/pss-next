import type { ProductionOverlapCliOptions } from "./production-overlap-options";
import { writeProductionOverlapReceipt } from "./production-overlap-storage";

export async function writeProductionOverlapCommandReceipt(
  options: ProductionOverlapCliOptions,
  startedAt: string,
  status: "completed" | "failed" | "running",
  error: string | null
): Promise<void> {
  await writeProductionOverlapReceipt(options.outputDirectory, {
    argv: [
      "--mode",
      options.mode,
      "--output",
      options.outputDirectory,
      "--repetitions",
      String(options.repetitions),
      "--attempt-timeout-ms",
      String(options.attemptTimeoutMs),
    ],
    completedAt: status === "running" ? null : new Date().toISOString(),
    error,
    startedAt,
    status,
  });
}
