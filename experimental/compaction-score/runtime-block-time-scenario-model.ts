import {
  type LanguageModelMiddleware,
  simulateStreamingMiddleware,
  wrapLanguageModel,
} from "ai";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";
import {
  isCompactionProviderPrompt,
  type RuntimeBlockLanguageModel,
} from "./runtime-block-time-runner";

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
        if (scenario === "summary-failure-recovery" && summaryCalls === 1) {
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
        if (scenario === "summary-failure-recovery" && summaryCalls === 1) {
          throw new TypeError("injected summary failure");
        }
      }
      const result = await doStream();
      return result;
    },
  };
  const supportsStream =
    typeof (model as { readonly doStream?: unknown }).doStream === "function";
  return {
    model: wrapLanguageModel({
      middleware: supportsStream
        ? middleware
        : [middleware, simulateStreamingMiddleware()],
      model,
    }),
  };
}
