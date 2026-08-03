import { MockLanguageModelV4 } from "ai/test";

type MockLanguageModelV4Options = NonNullable<
  ConstructorParameters<typeof MockLanguageModelV4>[0]
>;
type MockLanguageModelV4Generate = NonNullable<
  MockLanguageModelV4Options["doGenerate"]
>;
type MockLanguageModelV4GenerateValue = Exclude<
  MockLanguageModelV4Generate,
  (...args: never[]) => unknown
>;
export type MockLanguageModelV4GenerateResult = Extract<
  MockLanguageModelV4GenerateValue,
  { readonly content: unknown }
>;
type MockLanguageModelV4GenerateFunction = Extract<
  MockLanguageModelV4Generate,
  (...args: never[]) => unknown
>;
export type MockLanguageModelV4CallOptions =
  Parameters<MockLanguageModelV4GenerateFunction>[0];

const emptyUsage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: undefined,
  },
  outputTokens: {
    reasoning: undefined,
    text: undefined,
    total: undefined,
  },
} satisfies MockLanguageModelV4GenerateResult["usage"];

export function createMockLanguageModelV4(
  results:
    | readonly MockLanguageModelV4GenerateResult[]
    | MockLanguageModelV4GenerateFunction
): MockLanguageModelV4 {
  const model = new MockLanguageModelV4({
    doGenerate: typeof results === "function" ? results : [...results],
  });
  Object.defineProperty(model, "doStream", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  return model;
}

export function mockLanguageModelV4Text(
  text: string,
  usage: MockLanguageModelV4GenerateResult["usage"] = emptyUsage
): MockLanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { raw: "stop", unified: "stop" },
    usage,
    warnings: [],
  };
}
