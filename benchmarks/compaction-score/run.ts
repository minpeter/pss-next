import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readOpenAICompatibleModelEnv } from "@minpeter/pss-coding-agent/env";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import {
  BENCHMARK_HELP,
  type BenchmarkOptions,
  parseBenchmarkOptions,
} from "./benchmark-options";
import {
  createCampaignManifest,
  createPreflightReport,
} from "./campaign-manifest";
import type { BenchmarkScenario, CompactionFixture } from "./fixture";
import {
  CampaignValidationError,
  sanitizeProviderCampaignIdentity,
} from "./provider-campaign";
import { summarizeTrials, type TrialRecord } from "./report";
import {
  BENCHMARK_SCENARIOS,
  buildScenarioFixture,
  scenarioForFixtureIndex,
} from "./scenario-fixtures";
import { preflightSeedCapability, SeedPreflightError } from "./seed-preflight";
import { runCompactionTrial } from "./trial-runner";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(BENCHMARK_HELP);
} else {
  try {
    await runBenchmark(parseBenchmarkOptions(args));
  } catch (error) {
    if (
      error instanceof CampaignValidationError ||
      error instanceof SeedPreflightError
    ) {
      console.error(error.code);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  const requestedScenario = selectScenario(options.scenario);
  const model = createCodingLanguageModel({
    providerName: options.providerLabel,
  });
  const env = readOpenAICompatibleModelEnv();
  const provider = sanitizeProviderCampaignIdentity({
    baseUrl: env.AI_BASE_URL,
    label: options.providerLabel,
    modelId: env.AI_MODEL,
  });
  const seedCapability = await preflightSeedCapability({
    model,
    omitSeed: options.omitSummarySeed,
  });
  const manifest = createCampaignManifest({
    createdAt: new Date().toISOString(),
    mode: options.preflightOnly ? "preflight" : "benchmark",
    options: {
      fixtures: options.fixtures,
      maxAttempts: options.maxAttempts,
      omitSummarySeed: options.omitSummarySeed,
      seed: options.seed,
      summaryMaxOutputTokens: options.summaryMaxOutputTokens,
      trials: options.trials,
    },
    provider,
    seedCapability,
  });
  const preflightReport = createPreflightReport(provider, seedCapability);

  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(
      join(options.outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    ),
    writeFile(
      join(options.outputDir, "preflight.json"),
      `${JSON.stringify(preflightReport, null, 2)}\n`
    ),
  ]);

  if (options.preflightOnly) {
    console.log(JSON.stringify(preflightReport, null, 2));
    console.log(`report: ${options.outputDir}`);
    return;
  }

  const records: TrialRecord[] = [];
  const fixtureRecords: CompactionFixture[] = [];
  const trialsPath = join(options.outputDir, "trials.jsonl");
  const targetValidTrials = options.fixtures * options.trials;
  for (
    let fixtureIndex = 0;
    fixtureIndex < options.fixtures;
    fixtureIndex += 1
  ) {
    const scenario = requestedScenario ?? scenarioForFixtureIndex(fixtureIndex);
    const fixtureSeed = `${options.seed}-${scenario}-${fixtureIndex + 1}`;
    const fixture = buildScenarioFixture(scenario, fixtureSeed);
    fixtureRecords.push(fixture);

    for (let repetition = 1; repetition <= options.trials; repetition += 1) {
      let valid = false;
      for (
        let attempt = 1;
        attempt <= options.maxAttempts && !valid;
        attempt += 1
      ) {
        const id = `f${fixtureIndex + 1}-r${repetition}-a${attempt}`;
        console.log(
          `[${id}] scenario=${scenario} hops=${fixture.compactionEnds.length} questions=${fixture.questions.length}`
        );
        const record = await runCompactionTrial({
          attempt,
          fixture,
          fixtureSeed,
          id,
          model,
          repetition,
          ...(options.omitSummarySeed
            ? {}
            : { seed: numericSeed(`${fixtureSeed}:${repetition}:${attempt}`) }),
          summaryMaxOutputTokens: options.summaryMaxOutputTokens,
        });
        records.push(record);
        await appendFile(trialsPath, `${JSON.stringify(record)}\n`);

        if (record.status === "valid") {
          valid = true;
          console.log(
            `  valid compacted=${record.score.headline.correct}/${record.score.headline.total} summaryRatio=${(record.summaryTokens / record.prefixTokens).toFixed(3)}`
          );
        } else {
          console.log(
            `  invalid status=${record.status} error=${record.error}`
          );
        }
      }
    }
  }

  await writeFile(
    join(options.outputDir, "fixtures.json"),
    JSON.stringify(fixtureRecords, null, 2)
  );
  const summary = summarizeTrials(records);
  await writeFile(
    join(options.outputDir, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  console.log(JSON.stringify(summary, null, 2));
  console.log(`report: ${options.outputDir}`);

  if (summary.trials.valid < targetValidTrials) {
    console.error(
      `Only ${summary.trials.valid}/${targetValidTrials} required valid trials completed.`
    );
    process.exitCode = 1;
  }
}

function numericSeed(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

function selectScenario(
  value: string | undefined
): BenchmarkScenario | undefined {
  if (value === undefined) {
    return;
  }
  const scenario = BENCHMARK_SCENARIOS.find((item) => item === value);
  if (scenario === undefined) {
    throw new TypeError(`Unknown benchmark scenario: ${value}`);
  }
  return scenario;
}
