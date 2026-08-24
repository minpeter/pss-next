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

const TERMINAL_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function formatComparisonReportLocation(reportPath: string): string {
  const encodedPath = JSON.stringify(reportPath).replace(
    TERMINAL_CONTROL,
    (character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) {
        return "";
      }
      if (codePoint <= 0xff_ff) {
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
      const scalar = codePoint - 0x1_00_00;
      const high = 0xd8_00 + Math.floor(scalar / 0x4_00);
      const low = 0xdc_00 + (scalar % 0x4_00);
      return `\\u${high.toString(16)}\\u${low.toString(16)}`;
    }
  );
  return `report: ${encodedPath}`;
}

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
  const reportPath = join(outputDir, "comparison.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.aggregate, null, 2));
  console.log(formatComparisonReportLocation(reportPath));
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
