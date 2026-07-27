import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../../index";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectSqliteEventStore } from "./event-store";

const prefix = "pss-runtime-event-roundtrip";
const runId = "run-agent-event-variants";

describe("DurableObjectSqliteEventStore AgentEvent round-trip", () => {
  it("round-trips every AgentEvent variant", async () => {
    const store = new DurableObjectSqliteEventStore(
      new InMemoryCloudflareDurableObjectStorage({
        sql: new InMemorySqlStorage(),
      }),
      prefix
    );
    const events = agentEventVariants();

    for (const event of events) {
      await store.append(runId, event);
    }

    await expect(collectEvents(store, runId)).resolves.toEqual(events);
  });
});

function agentEventVariants(): readonly AgentEvent[] {
  return [
    { meta: { source: "send" }, text: "hello", type: "user-input" },
    {
      content: [
        { text: "multipart text", type: "text" },
        {
          data: "data:image/png;base64,AAAA",
          mediaType: "image/png",
          type: "file",
        },
        {
          data: {
            reference: { objectKey: "uploads/file.txt" },
            type: "reference",
          },
          filename: "file.txt",
          mediaType: "text/plain",
          type: "file",
        },
      ],
      meta: { source: "notify" },
      type: "user-input",
    },
    {
      input: { text: "runtime says continue", type: "user-input" },
      meta: { source: "steer" },
      placement: "step-start",
      type: "runtime-input",
    },
    { type: "turn-start" },
    { type: "turn-abort" },
    { message: "model unavailable", type: "turn-error" },
    {
      error: {
        category: "permission",
        correlationIds: [
          { source: "x-request-id", value: "request-roundtrip" },
        ],
        observedRetryable: false,
        status: 403,
        version: 1,
      },
      message: "access denied",
      type: "turn-error",
    },
    { type: "turn-end" },
    { type: "step-start" },
    {
      attemptId: "attempt-provider-a",
      cacheReadTokens: 768,
      cacheWriteTokens: 256,
      durationMs: 125.5,
      finishReason: "stop",
      inputTokens: 1024,
      modelId: "model-a",
      noCacheTokens: 256,
      outputTokens: 64,
      provider: "provider-a",
      reasoningTokens: 16,
      totalTokens: 1088,
      type: "model-usage",
    },
    { text: "hidden chain summary", type: "assistant-reasoning" },
    { text: "visible answer", type: "assistant-output" },
    {
      input: { query: "weather", units: "metric" },
      toolCallId: "call_weather",
      toolName: "weather",
      type: "tool-call",
    },
    {
      output: { temperature: 21, unit: "celsius" },
      toolCallId: "call_weather",
      toolName: "weather",
      type: "tool-result",
    },
    { type: "step-end" },
  ] satisfies readonly AgentEvent[];
}

async function collectEvents(
  store: DurableObjectSqliteEventStore,
  runIdValue: string
): Promise<readonly AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const entry of store.read(runIdValue)) {
    events.push(entry.event);
  }
  return events;
}
