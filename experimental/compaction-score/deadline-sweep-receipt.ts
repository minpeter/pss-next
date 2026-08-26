import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CommandReceiptEvidence,
  validateCompletedCommandReceipt,
} from "./command-receipt-validation";
import type { DeadlineSweepReport } from "./deadline-sweep-types";
import { sha256 } from "./human-calibration-utils";

export function validateDeadlineSweepReceipt(
  artifactPath: string,
  deadlineMs: number
): Promise<CommandReceiptEvidence> {
  const output = dirname(artifactPath);
  return validateCompletedCommandReceipt({
    expected: {
      "--deadline-ms": String(deadlineMs),
      "--mode": "live",
      "--output": output,
      "--repetitions": "10",
      "--start-repetition": "1",
    },
    path: join(output, "runtime-deadline-outcome-command.json"),
    pathFlags: ["--output"],
  });
}

export async function validateDeadlineSweepInputEvidence(
  report: DeadlineSweepReport
): Promise<void> {
  if (report.inputEvidence === null) {
    throw new TypeError("Deadline input evidence is missing.");
  }
  for (const [deadline, evidence] of Object.entries(report.inputEvidence)) {
    const contents = await readFile(evidence.source, "utf8");
    if (sha256(contents) !== evidence.artifactSha256) {
      throw new TypeError("Deadline arm artifact hash is stale.");
    }
    if (evidence.receiptPolicy === "exact-live-command") {
      const receipt = await validateDeadlineSweepReceipt(
        evidence.source,
        Number(deadline)
      );
      if (receipt.sha256 !== evidence.receiptSha256) {
        throw new TypeError("Deadline arm receipt hash is stale.");
      }
    }
  }
}
