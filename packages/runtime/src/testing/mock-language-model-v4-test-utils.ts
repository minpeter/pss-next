import { MockLanguageModelV4 } from "ai/test";

type MockLanguageModelV4Options = NonNullable<
  ConstructorParameters<typeof MockLanguageModelV4>[0]
>;
export type MockLanguageModelV4Generate = NonNullable<
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
export type MockLanguageModelV4Usage =
  MockLanguageModelV4GenerateResult["usage"];
export type MockLanguageModelV4GenerateFunction = Extract<
  MockLanguageModelV4Generate,
  (...args: never[]) => unknown
>;
export type MockLanguageModelV4Stream = NonNullable<
  MockLanguageModelV4Options["doStream"]
>;
export type MockLanguageModelV4StreamFunction = Extract<
  MockLanguageModelV4Stream,
  (...args: never[]) => unknown
>;
type MockLanguageModelV4StreamValue = Exclude<
  MockLanguageModelV4Stream,
  (...args: never[]) => unknown
>;
export type MockLanguageModelV4StreamResult = Extract<
  MockLanguageModelV4StreamValue,
  { readonly stream: unknown }
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

export function createStreamingMockLanguageModelV4(
  results:
    | readonly MockLanguageModelV4StreamResult[]
    | MockLanguageModelV4StreamFunction
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: typeof results === "function" ? results : [...results],
  });
}

export function mockLanguageModelV4Text(
  text: string,
  usage: MockLanguageModelV4Usage = emptyUsage
): MockLanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { raw: "stop", unified: "stop" },
    usage,
    warnings: [],
  };
}

export function mockLanguageModelV4ToolCall({
  input,
  toolCallId,
  toolName,
  usage = emptyUsage,
}: {
  input: unknown;
  toolCallId: string;
  toolName: string;
  usage?: MockLanguageModelV4Usage;
}): MockLanguageModelV4GenerateResult {
  return {
    content: [
      {
        input: JSON.stringify(input),
        toolCallId,
        toolName,
        type: "tool-call",
      },
    ],
    finishReason: { raw: "tool-calls", unified: "tool-calls" },
    usage,
    warnings: [],
  };
}

export function mockLanguageModelV4Empty(): MockLanguageModelV4GenerateResult {
  return {
    content: [],
    finishReason: { raw: "stop", unified: "stop" },
    usage: emptyUsage,
    warnings: [],
  };
}
