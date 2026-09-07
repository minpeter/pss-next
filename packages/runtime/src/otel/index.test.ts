import { SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent/core/agent";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import type { AgentEvent } from "../thread/protocol/events";
import type { AgentTurn } from "../thread/protocol/turn";
import { openTelemetry, traceAgentTurn } from "./index";
import { collectEvents, RecordingTracer, spanNamed } from "./test-support";

describe("traceAgentTurn", () => {
  it("traces every turn returned through agent instrumentation", async () => {
    const tracer = new RecordingTracer();
    const agent = new Agent({
      instrumentations: [openTelemetry({ tracer })],
      model: createMockLanguageModelV4(() =>
        Promise.resolve(mockLanguageModelV4Text("DONE"))
      ),
    });

    await collectEvents((await agent.send("first")).events());
    await collectEvents((await agent.send("second")).events());

    expect(
      tracer.spans.filter((span) => span.name === "pss.runtime.turn")
    ).toHaveLength(2);
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
  });

  it("records retry scheduling and terminal state without provider payloads", async () => {
    const events = [
      {
        attempt: 1,
        attemptId: "retry-step",
        delayMs: 2000,
        phase: "scheduled",
        remainingRetries: 2,
        retryAt: 1_800_000_002_000,
        type: "model-retry",
      },
      {
        attempt: 1,
        attemptId: "retry-step",
        phase: "started",
        remainingRetries: 1,
        type: "model-retry",
      },
      {
        attempt: 2,
        attemptId: "retry-step",
        phase: "stopped",
        reason: "non-retryable",
        remainingRetries: 0,
        type: "model-retry",
      },
      { type: "turn-end" },
    ] satisfies AgentEvent[];
    const tracer = new RecordingTracer();
    expect(
      await collectEvents(
        traceAgentTurn(singleUseTurn(events), { tracer }).events()
      )
    ).toEqual(events);
    const recorded = spanNamed(tracer, "pss.runtime.turn").events;
    expect(recorded[0]?.attributes).toEqual({
      "pss.event.type": "model-retry",
      "pss.model_retry.attempt": 1,
      "pss.model_retry.attempt_id": "retry-step",
      "pss.model_retry.delay_ms": 2000,
      "pss.model_retry.phase": "scheduled",
      "pss.model_retry.remaining_retries": 2,
      "pss.model_retry.retry_at": 1_800_000_002_000,
    });
    expect(recorded[1]?.attributes).toEqual({
      "pss.event.type": "model-retry",
      "pss.model_retry.attempt": 1,
      "pss.model_retry.attempt_id": "retry-step",
      "pss.model_retry.phase": "started",
      "pss.model_retry.remaining_retries": 1,
    });
    expect(recorded[2]?.attributes).toEqual({
      "pss.event.type": "model-retry",
      "pss.model_retry.attempt": 2,
      "pss.model_retry.attempt_id": "retry-step",
      "pss.model_retry.phase": "stopped",
      "pss.model_retry.reason": "non-retryable",
      "pss.model_retry.remaining_retries": 0,
    });
  });

  it("passes every event through while closing turn, step, and tool spans", async () => {
    const usage = {
      attemptId: "attempt-1",
      inputTokens: 12,
      outputTokens: 3,
      type: "model-usage",
    } satisfies AgentEvent;
    const sourceEvents = [
      { meta: { source: "send" }, text: "private user", type: "user-input" },
      { type: "turn-start" },
      { type: "step-start" },
      usage,
      { text: "private answer", type: "assistant-output" },
      {
        input: { query: "private tool input" },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-call",
      },
      {
        output: { result: "private tool output" },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-result",
      },
      { type: "step-end" },
      { type: "turn-end" },
    ] satisfies readonly AgentEvent[];
    const tracer = new RecordingTracer();

    const collected = await collectEvents(
      traceAgentTurn(singleUseTurn(sourceEvents), { tracer }).events()
    );

    expect(collected).toEqual(sourceEvents);
    expect(collected[3]).toBe(usage);
    expect(tracer.spans.map((span) => span.name)).toEqual([
      "pss.runtime.turn",
      "pss.runtime.step",
      "pss.runtime.tool",
    ]);
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
    expect(spanNamed(tracer, "pss.runtime.turn").status).toEqual({
      code: SpanStatusCode.OK,
    });
    expect(
      spanNamed(tracer, "pss.runtime.turn").events.map(
        (event) => event.attributes?.["pss.event.type"]
      )
    ).toEqual(sourceEvents.map((event) => event.type));
  });

  it.each([
    {
      event: { type: "turn-abort" } as const,
      message: "turn aborted",
    },
    {
      event: { message: "private failure", type: "turn-error" } as const,
      message: "turn error",
    },
  ])("marks $event.type spans as errors", async ({ event, message }) => {
    const tracer = new RecordingTracer();

    await collectEvents(
      traceAgentTurn(
        singleUseTurn([{ type: "turn-start" }, { type: "step-start" }, event]),
        { tracer }
      ).events()
    );

    expect(tracer.spans.every((span) => span.ended)).toBe(true);
    expect(spanNamed(tracer, "pss.runtime.turn").status).toEqual({
      code: SpanStatusCode.ERROR,
      message,
    });
    expect(telemetryText(tracer)).not.toContain("private failure");
  });

  it("records metadata-only summaries without invoking payload toJSON", async () => {
    const secrets = [
      "private user",
      "private file",
      "private answer",
      "private reasoning",
      "private tool input",
      "private tool output",
      "private failure",
    ];
    const throwingToJSON = () => {
      throw new Error("payload toJSON must stay inert");
    };
    const sourceEvents = [
      {
        content: [
          { text: secrets[0], type: "text" },
          {
            data: { text: secrets[1], type: "text" },
            mediaType: "text/plain",
            type: "file",
          },
        ],
        type: "user-input",
      },
      { type: "turn-start" },
      { type: "step-start" },
      { text: secrets[2], type: "assistant-output" },
      { text: secrets[3], type: "assistant-reasoning" },
      {
        input: { secret: secrets[4], toJSON: throwingToJSON },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-call",
      },
      {
        output: { secret: secrets[5], toJSON: throwingToJSON },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-result",
      },
      { message: secrets[6], type: "turn-error" },
    ] satisfies readonly AgentEvent[];
    const tracer = new RecordingTracer();

    const collected = await collectEvents(
      traceAgentTurn(singleUseTurn(sourceEvents), { tracer }).events()
    );

    expect(collected).toEqual(sourceEvents);
    const telemetry = telemetryText(tracer);
    for (const secret of secrets) {
      expect(telemetry).not.toContain(secret);
    }
    expect(eventAttributesFor(tracer, "assistant-output")).toMatchObject({
      "pss.assistant_output.text_length": secrets[2].length,
    });
    expect(eventAttributesFor(tracer, "tool-call")).toMatchObject({
      "pss.tool.input.key_count": 2,
      "pss.tool.input.type": "object",
    });
    expect(eventAttributesFor(tracer, "tool-result")).toMatchObject({
      "pss.tool.output.key_count": 2,
      "pss.tool.output.type": "object",
    });
  });

  it("preserves single-consumption and closes spans on iterator return", async () => {
    let returned = false;
    let sourceCalls = 0;
    const tracer = new RecordingTracer();
    const source: AgentTurn = {
      events: () => {
        sourceCalls += 1;
        return (async function* () {
          await Promise.resolve();
          try {
            yield { type: "turn-start" } satisfies AgentEvent;
            yield { type: "step-start" } satisfies AgentEvent;
          } finally {
            returned = true;
          }
        })();
      },
    };
    const traced = traceAgentTurn(source, { tracer });
    const iterator = traced.events()[Symbol.asyncIterator]();

    expect(() => traced.events()).toThrow(
      "AgentTurn.events() can only be consumed once"
    );
    expect(sourceCalls).toBe(1);
    await iterator.next();
    await iterator.next();
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(returned).toBe(true);
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
  });

  it("sanitizes source errors, closes spans, and rethrows the original", async () => {
    const tracer = new RecordingTracer();
    const sourceError = new Error("private source error");
    const turn: AgentTurn = {
      events: () =>
        (async function* () {
          await Promise.resolve();
          yield { type: "turn-start" } satisfies AgentEvent;
          yield { type: "step-start" } satisfies AgentEvent;
          throw sourceError;
        })(),
    };

    await expect(
      collectEvents(traceAgentTurn(turn, { tracer }).events())
    ).rejects.toBe(sourceError);

    expect(tracer.spans.every((span) => span.ended)).toBe(true);
    expect(spanNamed(tracer, "pss.runtime.turn").status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "source iterator failed",
    });
    expect(telemetryText(tracer)).not.toContain(sourceError.message);
  });
});

function eventAttributesFor(tracer: RecordingTracer, type: AgentEvent["type"]) {
  const event = spanNamed(tracer, "pss.runtime.turn").events.find(
    (candidate) => candidate.attributes?.["pss.event.type"] === type
  );
  if (!event?.attributes) {
    throw new Error(`Missing telemetry event for ${type}`);
  }
  return event.attributes;
}

function singleUseTurn(
  events: readonly AgentEvent[],
  onReturn: () => void = () => undefined
): AgentTurn {
  let consumed = false;
  return {
    events: () => {
      if (consumed) {
        throw new Error("AgentTurn.events() can only be consumed once");
      }
      consumed = true;
      return (async function* () {
        await Promise.resolve();
        try {
          for (const event of events) {
            yield event;
          }
        } finally {
          onReturn();
        }
      })();
    },
  };
}

function telemetryText(tracer: RecordingTracer): string {
  return JSON.stringify({
    events: tracer.spans.flatMap((span) => span.events),
    exceptions: tracer.spans.flatMap((span) =>
      span.exceptions.map((exception) => exception.message)
    ),
    statuses: tracer.spans.map((span) => span.status),
  });
}
