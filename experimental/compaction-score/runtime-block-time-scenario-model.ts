import type { LanguageModelMiddleware } from "ai";
import {
  isCompactionProviderPrompt,
  type RuntimeBlockLanguageModel,
  wrapRuntimeBlockModel,
} from "./runtime-block-time-instrumentation";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";

export interface RuntimeBlockScenarioModel {
  readonly model: RuntimeBlockLanguageModel;
}

export function createRuntimeBlockScenarioModel(
  model: RuntimeBlockLanguageModel,
  scenario: RuntimeBlockScenario
): RuntimeBlockScenarioModel {
  let summaryCalls = 0;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const summary = isCompactionProviderPrompt(params.prompt);
      if (summary) {
        summaryCalls += 1;
        if (shouldFailSummary(scenario, summaryCalls)) {
          throw new TypeError("injected summary failure");
        }
      }
      const result = await doGenerate();
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const summary = isCompactionProviderPrompt(params.prompt);
      if (summary) {
        summaryCalls += 1;
        if (shouldFailSummary(scenario, summaryCalls)) {
          throw new TypeError("injected summary failure");
        }
      }
      const result = await doStream();
      return result;
    },
  };
  return { model: wrapRuntimeBlockModel(model, middleware) };
}

function shouldFailSummary(
  scenario: RuntimeBlockScenario,
  summaryCalls: number
): boolean {
  return (
    (scenario === "summary-failure-retry-hit" && summaryCalls === 1) ||
    (scenario === "repeated-failure-overflow-recovery" && summaryCalls <= 2)
  );
}
