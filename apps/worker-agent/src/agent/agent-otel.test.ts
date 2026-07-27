import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import {
  type Attributes,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  SpanStatusCode,
  type TimeInput,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  collectTurnDelivery,
  createConfiguredAgent,
  type WorkerAgentModelEnv,
} from "./agent";

const USER_TEXT = "SENTINEL-USER-TEXT-6f2c";
const ASSISTANT_REPLY = "SENTINEL-ASSISTANT-REPLY-91ab";

// Default span names from @minpeter/pss-runtime/otel. Hardcoded on purpose:
// the worker wires the stock instrumentation, so these names are its contract.
const TURN_SPAN_NAME = "pss.runtime.turn";
const STEP_SPAN_NAME = "pss.runtime.step";

interface RecordedSpanEvent {
  readonly attributes?: Attributes;
  readonly name: string;
}

interface RecordedSpan {
  attributes: Attributes;
  ended: boolean;
  events: RecordedSpanEvent[];
  exceptions: unknown[];
  name: string;
  status: SpanStatus | undefined;
}

const recordedSpans: RecordedSpan[] = [];

const TEST_SPAN_CONTEXT: SpanContext = {
  spanId: "0000000000000001",
  traceFlags: 1,
  traceId: "00000000000000000000000000000001",
};

function isAttributes(value: unknown): value is Attributes {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRecordingStartSpan(recorded: RecordedSpan[]) {
  return (name: string, options?: SpanOptions): Span => {
    const record: RecordedSpan = {
      attributes: { ...options?.attributes },
      ended: false,
      events: [],
      exceptions: [],
      name,
      status: undefined,
    };
    recorded.push(record);

    const span: Span = {
      addEvent: (
        eventName: string,
        attributesOrStartTime?: Attributes | TimeInput,
        _startTime?: TimeInput
      ): Span => {
        record.events.push({
          name: eventName,
          ...(isAttributes(attributesOrStartTime)
            ? { attributes: attributesOrStartTime }
            : {}),
        });
        return span;
      },
      addLink: (): Span => span,
      addLinks: (): Span => span,
      end: (): void => {
        record.ended = true;
      },
      isRecording: (): boolean => !record.ended,
      recordException: (exception: unknown): void => {
        record.exceptions.push(exception);
      },
      setAttribute: (key: string, value: unknown): Span => {
        record.attributes[key] = value as Attributes[string];
        return span;
      },
      setAttributes: (attributes: Attributes): Span => {
        Object.assign(record.attributes, attributes);
        return span;
      },
      setStatus: (status: SpanStatus): Span => {
        record.status = status;
        return span;
      },
      spanContext: (): SpanContext => TEST_SPAN_CONTEXT,
      updateName: (nextName: string): Span => {
        record.name = nextName;
        return span;
      },
    };
    return span;
  };
}

const inMemoryTracer: Tracer = {
  startActiveSpan: ((): never => {
    throw new Error(
      "startActiveSpan is not supported by the in-memory test tracer"
    );
  }) as Tracer["startActiveSpan"],
  startSpan: createRecordingStartSpan(recordedSpans),
};

const inMemoryTracerProvider: TracerProvider = {
  getTracer: (): Tracer => inMemoryTracer,
};

function testEnv(): WorkerAgentModelEnv {
  return {
    AI_API_KEY: "test-api-key",
    AI_BASE_URL: "https://ai.test/v1",
    AI_MODEL: "test-model",
    ENVIRONMENT: "development",
  };
}

function chatCompletionResponse(): Response {
  const chunks = [
    {
      choices: [
        {
          delta: { role: "assistant" },
          finish_reason: null,
          index: 0,
        },
      ],
      created: 0,
      id: "chatcmpl-test",
      model: "test-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [
        {
          delta: { content: ASSISTANT_REPLY },
          finish_reason: null,
          index: 0,
        },
      ],
      created: 0,
      id: "chatcmpl-test",
      model: "test-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [
        {
          delta: {},
          finish_reason: "stop",
          index: 0,
        },
      ],
      created: 0,
      id: "chatcmpl-test",
      model: "test-model",
      object: "chat.completion.chunk",
      usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
    },
  ];
  const body = `${chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;

  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

async function drainTurn(
  turn: AgentTurn
): Promise<{ readonly events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  await collectTurnDelivery(turn, {
    onEvent: (event) => {
      events.push(event);
    },
  });
  return { events };
}

describe("worker-agent OpenTelemetry wiring", () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(inMemoryTracerProvider);
  });

  afterEach(() => {
    recordedSpans.length = 0;
    vi.unstubAllGlobals();
  });

  it("emits turn and step spans for a send turn", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(chatCompletionResponse()));
    const agent = await createConfiguredAgent(testEnv(), createInMemoryHost());

    const turn = await agent.thread("otel-test").send(USER_TEXT);
    const { events } = await drainTurn(turn);

    const turnSpan = recordedSpans.find((span) => span.name === TURN_SPAN_NAME);
    const stepSpan = recordedSpans.find((span) => span.name === STEP_SPAN_NAME);

    expect(turnSpan).toBeDefined();
    expect(stepSpan).toBeDefined();
    expect(turnSpan?.ended).toBe(true);
    expect(stepSpan?.ended).toBe(true);
    expect(turnSpan?.status?.code).toBe(SpanStatusCode.OK);
    expect(stepSpan?.status?.code).toBe(SpanStatusCode.OK);
    expect(turnSpan?.attributes["pss.runtime.component"]).toBe(
      "@minpeter/pss-runtime"
    );
    expect(
      turnSpan?.events.some((event) => event.name === "pss.runtime.event")
    ).toBe(true);

    // Events flow through the wrapper unchanged and in order: the runtime
    // records user-input before the turn-start boundary.
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.at(0)).toBe("user-input");
    expect(eventTypes.at(-1)).toBe("turn-end");
    expect(eventTypes.indexOf("user-input")).toBeLessThan(
      eventTypes.indexOf("turn-start")
    );
    expect(eventTypes.indexOf("turn-start")).toBeLessThan(
      eventTypes.indexOf("step-start")
    );
    expect(eventTypes.indexOf("step-start")).toBeLessThan(
      eventTypes.indexOf("step-end")
    );
    expect(eventTypes.indexOf("step-end")).toBeLessThan(
      eventTypes.indexOf("turn-end")
    );
    const assistantOutput = events.find(
      (event): event is Extract<AgentEvent, { type: "assistant-output" }> =>
        event.type === "assistant-output"
    );
    expect(assistantOutput?.text).toBe(ASSISTANT_REPLY);

    // Spans carry metadata only, never message content.
    const serializedSpans = JSON.stringify(recordedSpans);
    expect(serializedSpans).not.toContain(USER_TEXT);
    expect(serializedSpans).not.toContain(ASSISTANT_REPLY);
  });

  it("preserves single-consumption of turn events", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(chatCompletionResponse()));
    const agent = await createConfiguredAgent(testEnv(), createInMemoryHost());

    const turn = await agent.thread("otel-test").send(USER_TEXT);
    await drainTurn(turn);

    expect(() => turn.events()).toThrow(
      "AgentTurn.events() can only be consumed once"
    );
  });

  it("traces steer turns through the same instrumentation", async () => {
    const completions: string[] = [];
    vi.stubGlobal("fetch", () => {
      completions.push("completion");
      return Promise.resolve(chatCompletionResponse());
    });
    const agent = await createConfiguredAgent(testEnv(), createInMemoryHost());
    const thread = agent.thread("otel-test");

    await drainTurn(await thread.send(USER_TEXT));
    recordedSpans.length = 0;
    await drainTurn(await thread.steer(USER_TEXT));

    expect(recordedSpans.some((span) => span.name === TURN_SPAN_NAME)).toBe(
      true
    );
    expect(recordedSpans.some((span) => span.name === STEP_SPAN_NAME)).toBe(
      true
    );
  });
});
