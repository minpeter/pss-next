import type { AgentEvent } from "@minpeter/pss-runtime";
import { APICallError } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

type MockStreamResult = Extract<
  Exclude<
    NonNullable<
      ConstructorParameters<typeof MockLanguageModelV4>[0]
    >["doStream"],
    (...args: never[]) => unknown
  >,
  { readonly stream: unknown }
>;
type MockStreamPart =
  MockStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 1,
  },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

export function createStreamingModel(): MockLanguageModelV4 {
  const chunks = [
    { type: "stream-start", warnings: [] },
    { id: "text-1", type: "text-start" },
    { delta: "hello", id: "text-1", type: "text-delta" },
    { id: "text-1", type: "text-end" },
    {
      finishReason: { raw: "stop", unified: "stop" },
      type: "finish",
      usage,
    },
  ] satisfies MockStreamPart[];
  return new MockLanguageModelV4({
    doStream: [{ stream: convertArrayToReadableStream(chunks) }],
  });
}

export function createFailingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () =>
      Promise.reject(
        new APICallError({
          isRetryable: false,
          message: "Access denied",
          requestBodyValues: {},
          responseHeaders: { "x-request-id": "extension-event" },
          statusCode: 403,
          url: "https://provider.example/v1/chat/completions",
        })
      ),
  });
}

export async function collectEvents(
  events: AsyncIterable<AgentEvent>
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
