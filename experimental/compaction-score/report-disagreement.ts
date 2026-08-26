import { createHash } from "node:crypto";
import type { BenchmarkScenario } from "./fixture";
import type { ScoreDisagreement } from "./scorer";

export function fingerprintDisagreement(
  scenario: BenchmarkScenario,
  disagreement: ScoreDisagreement
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scenario,
        disagreement.arm,
        disagreement.category,
        disagreement.question,
        disagreement.expected,
        disagreement.actual,
      ])
    )
    .digest("hex");
}
