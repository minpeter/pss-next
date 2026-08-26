import { dirname, join } from "node:path";
import {
  type CommandReceiptEvidence,
  validateCompletedCommandReceipt,
} from "./command-receipt-validation";
import type { TaskUtilityReport } from "./task-utility-types";

export function validateTaskUtilityReceipt(
  artifactPath: string,
  report: Pick<TaskUtilityReport, "attemptTimeoutMs" | "mode" | "repetitions">
): Promise<CommandReceiptEvidence> {
  if (report.mode === "live" && report.repetitions !== 3) {
    throw new TypeError("Live task utility receipt requires 3 repetitions.");
  }
  const output = dirname(artifactPath);
  return validateCompletedCommandReceipt({
    expected: {
      "--attempt-timeout-ms": String(report.attemptTimeoutMs),
      "--mode": report.mode,
      "--output": output,
      "--repetitions": String(report.repetitions),
    },
    path: join(output, "task-utility-command.json"),
    pathFlags: ["--output"],
  });
}
