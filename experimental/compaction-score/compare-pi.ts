/**
 * Head-to-head comparison of PSS runtime compaction and pi-coding-agent
 * compaction on identical fixtures, cut points, evaluator, scorer, output
 * budgets, temperature, and per-hop seeds.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readOpenAICompatibleModelEnv } from "@minpeter/pss-coding-agent/env";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import { runPiArm, runPssArm } from "./compare-pi-arms";
import {
  COMPARISON_SCENARIOS,
  type ComparisonScenario,
  REPETITIONS,
} from "./compare-pi-config";
import { runArmWithRetry, withSemanticScore } from "./compare-pi-judge";
import { buildComparisonReport, describeArm } from "./compare-pi-report";
import type { ComparisonRow } from "./compare-pi-types";
import type { CompactionFixture } from "./fixture";
import { buildHoldoutFixture } from "./holdout-fixtures";
import { buildScenarioFixture } from "./scenario-fixtures";

async function main(): Promise<void> {
  const model = createCodingLanguageModel({ providerName: "compare-pi" });
  const env = readOpenAICompatibleModelEnv();
  const outputDir =
    process.argv[2] ?? `/tmp/compaction-vs-pi-${new Date().toISOString()}`;
  await mkdir(outputDir, { recursive: true });
  console.log("compare-pi-started");

  const rows: ComparisonRow[] = [];
  for (const scenario of COMPARISON_SCENARIOS) {
    const fixtureSeed = `compare-pi-${scenario}-1`;
    const fixture = buildComparisonFixture(scenario, fixtureSeed);
    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      console.log(
        `[${scenario} r${repetition}] hops=${fixture.compactionEnds.length} questions=${fixture.questions.length}`
      );
      const pss = await withSemanticScore(
        model,
        await runArmWithRetry(() =>
          runPssArm({ fixture, fixtureSeed, model, repetition })
        )
      );
      console.log(`  pss: ${describeArm(pss)}`);
      const pi = await withSemanticScore(
        model,
        await runArmWithRetry(() => runPiArm(fixture, repetition, model))
      );
      console.log(`  pi : ${describeArm(pi)}`);
      rows.push({ pi, pss, repetition, scenario });
    }
  }

  const report = buildComparisonReport(rows, env.AI_MODEL);
  await writeFile(
    join(outputDir, "comparison.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  console.log(JSON.stringify(report.aggregate, null, 2));
  console.log("report: comparison.json");
}

function buildComparisonFixture(
  scenario: ComparisonScenario,
  fixtureSeed: string
): CompactionFixture {
  if (
    scenario === "holdout-json" ||
    scenario === "holdout-cjk" ||
    scenario === "holdout-log"
  ) {
    return buildHoldoutFixture(scenario, fixtureSeed);
  }
  return buildScenarioFixture(scenario, fixtureSeed);
}

const executable = process.argv[1];
if (executable && import.meta.url === pathToFileURL(executable).href) {
  try {
    await main();
  } catch {
    process.stderr.write("compare-pi-failure\n");
    process.exitCode = 1;
  }
}
