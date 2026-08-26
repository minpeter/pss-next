import { writeRuntimeDeadlineReceipt } from "./runtime-deadline-outcome-cli-support";

export async function recordRuntimeDeadlineReceipt(
  outputDirectory: string,
  startedAt: string,
  status: "completed" | "failed" | "running",
  error: string | null,
  argv: readonly string[]
): Promise<void> {
  await writeRuntimeDeadlineReceipt(outputDirectory, {
    argv,
    completedAt: status === "running" ? null : new Date().toISOString(),
    error,
    startedAt,
    status,
  });
}
