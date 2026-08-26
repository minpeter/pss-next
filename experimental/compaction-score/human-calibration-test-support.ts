import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HUMAN_CALIBRATION_SECRET_ENV } from "./human-calibration-sealing";

const execFileAsync = promisify(execFile);
export const COORDINATOR_SECRET =
  "human-calibration-coordinator-secret-alpha-2026";

export function qualityFixture() {
  return {
    calibrationItems: [
      {
        compactedAnswer: "R-18",
        fullAnswer: "R-18",
        messages: [{ content: "Release is R-17", role: "user" as const }],
        questions: [
          {
            answer: "R-17",
            category: "exact-recall",
            question: "Which release?",
          },
        ],
        scenario: "baseline",
        seed: "human-test",
      },
    ],
    schemaVersion: "quality-sweep-v2",
  };
}

export async function runHumanCalibration(
  args: readonly string[]
): Promise<void> {
  await execFileAsync(
    "../../node_modules/.bin/tsx",
    ["--conditions=@minpeter/pss-source", "human-calibration-cli.ts", ...args],
    {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        [HUMAN_CALIBRATION_SECRET_ENV]: COORDINATOR_SECRET,
      },
    }
  );
}
