import type { BenchmarkScenario } from "./fixture";
import { getCompactionPromptProfile } from "./prompt-profiles";
import { buildBatchedQuestionPrompt } from "./protocol";
import { BENCHMARK_SCENARIOS, buildScenarioFixture } from "./scenario-fixtures";

const { profileId, specs } = parseArgs(process.argv.slice(2));
const profile = getCompactionPromptProfile(profileId);

const packets = specs.map((spec) => {
  const { scenario, seed } = parseSpec(spec);
  const fixture = buildScenarioFixture(scenario, seed);
  return {
    compactionEnds: fixture.compactionEnds,
    evaluationPrompt: buildBatchedQuestionPrompt(fixture.questions),
    messages: fixture.messages,
    profile: {
      hash: profile.hash,
      id: profile.id,
      rules: profile.rules,
    },
    questions: fixture.questions,
    scenario,
    seed,
    summaryInstructions: profile.instructions,
  };
});

console.log(JSON.stringify(packets));

function parseArgs(args: readonly string[]): {
  readonly profileId: string;
  readonly specs: readonly string[];
} {
  let profileId = "production";
  const fixtureSpecs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--profile") {
      profileId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value?.startsWith("--")) {
      throw new TypeError(`Unknown option: ${value}`);
    }
    if (value) {
      fixtureSpecs.push(value);
    }
  }
  return {
    profileId,
    specs:
      fixtureSpecs.length > 0
        ? fixtureSpecs
        : BENCHMARK_SCENARIOS.map(
            (scenario) => `${scenario}=compaction-score-v3-${scenario}`
          ),
  };
}

function parseSpec(spec: string): {
  readonly scenario: BenchmarkScenario;
  readonly seed: string;
} {
  const separator = spec.indexOf("=");
  if (separator === -1) {
    return { scenario: "baseline", seed: spec };
  }
  const scenario = spec.slice(0, separator);
  const seed = spec.slice(separator + 1);
  if (!BENCHMARK_SCENARIOS.includes(scenario as BenchmarkScenario)) {
    throw new TypeError(`Unknown benchmark scenario: ${scenario}`);
  }
  return { scenario: scenario as BenchmarkScenario, seed };
}
