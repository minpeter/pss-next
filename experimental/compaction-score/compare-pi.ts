/**
 * Head-to-head comparison of PSS runtime compaction and pi-coding-agent
 * compaction on identical fixtures, cut points, evaluator, scorer, output
 * budgets, temperature, and per-hop seeds.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readOpenAICompatibleModelEnv } from "@minpeter/pss-coding-agent/env";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import { parseCampaignRepetitions } from "./campaign-limits";
import { runPiArm, runPssArm } from "./compare-pi-arms";
import {
  COMPARISON_SCENARIOS,
  COMPARISON_SUMMARY_OUTPUT_BUDGET,
  type ComparisonScenario,
  REPETITIONS,
} from "./compare-pi-config";
import { runArmWithRetry, withSemanticScore } from "./compare-pi-judge";
import { buildComparisonReport, describeArm } from "./compare-pi-report";
import {
  loadComparePiRows,
  writeComparePiReport,
  writeComparePiRows,
} from "./compare-pi-storage";
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

interface ComparePiOptions {
  readonly outputDirectory: string;
  readonly repetitions: number;
  readonly summaryMaxOutputTokens: number;
}

function parseOptions(args: readonly string[]): ComparePiOptions {
  let outputDirectory: string | undefined;
  let repetitions: number = REPETITIONS;
  let summaryMaxOutputTokens: number =
    COMPARISON_SUMMARY_OUTPUT_BUDGET.maxOutputTokens;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--output":
        outputDirectory = optionValue(args, ++index, argument);
        break;
      case "--repetitions":
        repetitions = parseCampaignRepetitions(
          optionValue(args, ++index, argument),
          "Compare-pi repetitions"
        );
        break;
      case "--summary-max-output-tokens":
        summaryMaxOutputTokens = positiveInteger(
          optionValue(args, ++index, argument)
        );
        break;
      default:
        if (
          argument === undefined ||
          argument.startsWith("--") ||
          outputDirectory !== undefined
        ) {
          throw new TypeError("Invalid compare-pi option.");
        }
        outputDirectory = argument;
    }
  }
  return {
    outputDirectory:
      outputDirectory ?? `/tmp/compaction-vs-pi-${new Date().toISOString()}`,
    repetitions,
    summaryMaxOutputTokens,
  };
}

function optionValue(
  args: readonly string[],
  index: number,
  flag: string
): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`Missing compare-pi value for ${flag}.`);
  }
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!(Number.isSafeInteger(parsed) && parsed > 0)) {
    throw new TypeError("Invalid compare-pi positive integer.");
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const model = createCodingLanguageModel({ providerName: "compare-pi" });
  const env = readOpenAICompatibleModelEnv();
  const outputDir = options.outputDirectory;
  await mkdir(outputDir, { recursive: true });
  console.log("compare-pi-started");

  const identity = {
    model: env.AI_MODEL,
    repetitions: options.repetitions,
    summaryMaxOutputTokens: options.summaryMaxOutputTokens,
  };
  const rows: ComparisonRow[] = [
    ...(await loadComparePiRows(outputDir, identity)),
  ];
  const completed = new Set(
    rows.map((row) => `${row.scenario}:${row.repetition}`)
  );
  for (const scenario of COMPARISON_SCENARIOS) {
    const fixtureSeed = `compare-pi-${scenario}-1`;
    const fixture = buildComparisonFixture(scenario, fixtureSeed);
    for (
      let repetition = 1;
      repetition <= options.repetitions;
      repetition += 1
    ) {
      const key = `${scenario}:${repetition}`;
      if (completed.has(key)) {
        console.log(`[${scenario} r${repetition}] resume=preserved`);
        continue;
      }
      console.log(
        `[${scenario} r${repetition}] hops=${fixture.compactionEnds.length} questions=${fixture.questions.length}`
      );
      const pss = await withSemanticScore(
        model,
        await runArmWithRetry(() =>
          runPssArm({
            fixture,
            fixtureSeed,
            model,
            repetition,
            summaryMaxOutputTokens: options.summaryMaxOutputTokens,
          })
        )
      );
      console.log(`  pss: ${describeArm(pss)}`);
      const pi = await withSemanticScore(
        model,
        await runArmWithRetry(() =>
          runPiArm(fixture, repetition, model, options.summaryMaxOutputTokens)
        )
      );
      console.log(`  pi : ${describeArm(pi)}`);
      rows.push({ pi, pss, repetition, scenario });
      completed.add(key);
      await writeComparePiRows(outputDir, identity, rows);
    }
  }

  const report = buildComparisonReport(rows, identity);
  const reportPath = join(outputDir, "comparison.json");
  await writeComparePiReport(outputDir, report);
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
