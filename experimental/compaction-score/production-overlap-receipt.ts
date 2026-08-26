import { dirname, join } from "node:path";
import {
  type CommandReceiptEvidence,
  validateCompletedCommandReceipt,
} from "./command-receipt-validation";
import type { ProductionOverlapReport } from "./production-overlap-types";

export function validateProductionOverlapReceipt(
  artifactPath: string,
  report: Pick<
    ProductionOverlapReport,
    "attemptTimeoutMs" | "mode" | "repetitions"
  >
): Promise<CommandReceiptEvidence> {
  if (report.mode === "live" && report.repetitions !== 10) {
    throw new TypeError("Live production receipt requires 10 repetitions.");
  }
  const output = dirname(artifactPath);
  return validateCompletedCommandReceipt({
    expected: {
      "--attempt-timeout-ms": String(report.attemptTimeoutMs),
      "--mode": report.mode,
      "--output": output,
      "--repetitions": String(report.repetitions),
    },
    path: join(output, "production-overlap-command.json"),
    pathFlags: ["--output"],
  });
}
