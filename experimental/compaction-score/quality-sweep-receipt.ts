import { dirname, join } from "node:path";
import {
  type CommandReceiptEvidence,
  validateCompletedCommandReceipt,
} from "./command-receipt-validation";
import type { QualitySweepReport } from "./quality-sweep-types";

export function validateQualitySweepReceipt(
  artifactPath: string,
  report: Pick<QualitySweepReport, "mode" | "repetitions">
): Promise<CommandReceiptEvidence> {
  if (report.mode === "live" && report.repetitions !== 3) {
    throw new TypeError("Live quality receipt requires 3 repetitions.");
  }
  const output = dirname(artifactPath);
  return validateCompletedCommandReceipt({
    expected: {
      "--mode": report.mode,
      "--output": output,
      "--repetitions": String(report.repetitions),
    },
    path: join(output, "quality-sweep-command.json"),
    pathFlags: ["--output"],
  });
}
