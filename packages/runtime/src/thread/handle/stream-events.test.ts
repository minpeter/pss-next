import { APICallError, jsonSchema, tool } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { createInMemoryHost } from "../../platform/memory";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4GenerateResult,
  type MockLanguageModelV4StreamResult,
  mockLanguageModelV4Empty,
} from "../../testing/mock-language-model-v4-test-utils";
import { createRuntimeInputState } from "../input/runtime-input";
import { type AgentEvent, isStreamAgentEvent } from "../protocol/events";
import { BufferedAgentTurn } from "../protocol/turn";
import { ThreadEventDispatcher } from "../runtime/thread-event-dispatcher";
import { recordDurableThreadEvent } from "../runtime/thread-event-log";
import { emitTurnEvent } from "../runtime/turn-events";
import { ThreadState } from "../state/thread-state";
import { collect } from "./test-support";

type MockStreamPart =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const lookupTool = tool({
  execute: () => ({ weather: "sunny" }),
  inputSchema: jsonSchema({
    additionalProperties: false,
    properties: { city: { type: "string" } },
    required: ["city"],
    type: "object",
  }),
});
const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 1,
  },
  outputTokens: { reasoning: 1, text: 2, total: 3 },
};
const toolInput = JSON.stringify({ city: "Seoul" });

const firstStreamChunks = [
  { type: "stream-start", warnings: [] },
  { id: "text-1", type: "text-start" },
  { delta: "hello ", id: "text-1", type: "text-delta" },
  { delta: "world", id: "text-1", type: "text-delta" },
  { id: "text-1", type: "text-end" },
  { id: "reasoning-1", type: "reasoning-start" },
  { delta: "thinking", id: "reasoning-1", type: "reasoning-delta" },
  { id: "reasoning-1", type: "reasoning-end" },
  { id: "call-1", toolName: "lookup", type: "tool-input-start" },
  { delta: toolInput, id: "call-1", type: "tool-input-delta" },
  { id: "call-1", type: "tool-input-end" },
  {
    input: toolInput,
    toolCallId: "call-1",
    toolName: "lookup",
    type: "tool-call",
  },
  {
    finishReason: { raw: "tool-calls", unified: "tool-calls" },
    type: "finish",
    usage,
  },
] satisfies MockStreamPart[];

const finalStreamChunks = [
  { type: "stream-start", warnings: [] },
  {
    finishReason: { raw: "stop", unified: "stop" },
    type: "finish",
    usage,
  },
] satisfies MockStreamPart[];

const generateFirstStep = {
  content: [
    { text: "hello world", type: "text" },
    { text: "thinking", type: "reasoning" },
    {
      input: toolInput,
      toolCallId: "call-1",
      toolName: "lookup",
      type: "tool-call",
    },
  ],
  finishReason: { raw: "tool-calls", unified: "tool-calls" },
  usage,
  warnings: [],
} satisfies MockLanguageModelV4GenerateResult;

const expectedLiveTypes = [
  "user-input",
  "turn-start",
  "step-start",
  "assistant-output-delta",
  "assistant-output-delta",
  "assistant-reasoning-delta",
  "tool-call-input-start",
  "tool-call-input-delta",
  "tool-call-input-end",
  "model-usage",
  "assistant-reasoning",
  "assistant-output",
  "tool-call",
  "tool-result",
  "step-end",
  "step-start",
  "model-usage",
  "step-end",
  "turn-end",
] satisfies AgentEvent["type"][];

describe("thread stream events", () => {
  it("emits deltas in source order before committed output", async () => {
    const thread = createStreamThread("stream-live-order");

    const live = await collect(await thread.send("go"));

    expect(
      live
        .filter(
          (event) =>
            event.type !== "context-usage" && event.type !== "model-attempt"
        )
        .map((event) => event.type)
    ).toEqual(expectedLiveTypes);
  });

  it("publishes real retry decisions without duplicating output or tool execution or persisting them", async () => {
    let calls = 0;
    let executions = 0;
    const agent = new Agent({
      host: createInMemoryHost(),
      model: createStreamingMockLanguageModelV4(() => {
        calls += 1;
        if (calls === 1) {
          throw new APICallError({
            message: "fixture",
            requestBodyValues: {},
            responseHeaders: { "retry-after-ms": "0" },
            statusCode: 429,
            url: "https://fixture.test",
          });
        }
        return Promise.resolve({
          stream: convertArrayToReadableStream<MockStreamPart>(
            calls === 2 ? firstStreamChunks : finalStreamChunks
          ),
        });
      }),
      tools: {
        lookup: tool({
          ...lookupTool,
          execute: () => {
            executions += 1;
            return { weather: "sunny" };
          },
        }),
      },
    });
    const thread = agent.thread("retry-live-and-replay");
    const live = await collect(await thread.send("go"));
    const replayed = await collectAsync(thread.events());
    const retryEvents = live.filter((event) => event.type === "model-retry");
    expect(retryEvents).toMatchObject([
      { attempt: 1, delayMs: 0, phase: "scheduled", remainingRetries: 2 },
      { attempt: 1, phase: "started", remainingRetries: 1 },
    ]);
    expect(
      live
        .filter((event) => event.type === "model-attempt")
        .map((event) => [event.attempt, event.phase])
    ).toEqual([
      [1, "start"],
      [1, "end"],
      [2, "start"],
      [2, "end"],
      [1, "start"],
      [1, "end"],
    ]);
    expect(calls).toBe(3);
    expect(executions).toBe(1);
    expect(
      live
        .filter((event) => event.type === "assistant-output-delta")
        .map((event) => event.text)
    ).toEqual(["hello ", "world"]);
    expect(live.filter((event) => event.type === "tool-result")).toHaveLength(
      1
    );
    expect(replayed.some(({ event }) => isStreamAgentEvent(event))).toBe(false);
    expect(replayed.map(({ event }) => event.type)).toEqual(
      committedTypes(live)
    );
    await agent.dispose();
  });

  it("publishes final cancellation when the live consumer interrupts a scheduled retry", async () => {
    let calls = 0;
    const agent = new Agent({
      host: createInMemoryHost(),
      model: createStreamingMockLanguageModelV4(() => {
        calls += 1;
        throw new APICallError({
          message: "fixture",
          requestBodyValues: {},
          statusCode: 429,
          url: "https://fixture.test",
        });
      }),
    });
    const thread = agent.thread("retry-interrupt");
    const turn = await thread.send("go");
    const live: AgentEvent[] = [];
    for await (const event of turn.events()) {
      live.push(event);
      if (event.type === "model-retry" && event.phase === "scheduled") {
        thread.interrupt();
      }
    }
    expect(calls).toBe(1);
    expect(live.filter((event) => event.type === "model-retry")).toMatchObject([
      { phase: "scheduled", remainingRetries: 2 },
      { phase: "stopped", reason: "cancelled", remainingRetries: 0 },
    ]);
    expect(live.at(-1)).toEqual({ type: "turn-abort" });
    expect(
      (await collectAsync(thread.events())).some(({ event }) =>
        isStreamAgentEvent(event)
      )
    ).toBe(false);
    await agent.dispose();
  });

  it("preserves committed event parity with doGenerate-only models", async () => {
    const streamThread = createStreamThread("stream-parity");
    const generateThread = createGenerateThread("generate-parity");

    const live = await collect(await streamThread.send("go"));
    const generated = await collect(await generateThread.send("go"));

    expect(committedTypes(generated)).toEqual(committedTypes(live));
  });

  it("excludes deltas from durable replay while retaining committed output", async () => {
    const thread = createStreamThread("stream-durable-replay");

    const live = await collect(await thread.send("go"));
    const replayed = await collectAsync(thread.events());

    expect(live.some((event) => isStreamAgentEvent(event))).toBe(true);
    expect(replayed.map(({ event }) => event.type)).toEqual(
      committedTypes(live)
    );
    expect(replayed.some(({ event }) => isStreamAgentEvent(event))).toBe(false);
    expect(replayed.map(({ event }) => event.type)).toEqual(
      expect.arrayContaining([
        "assistant-output",
        "assistant-reasoning",
        "tool-call",
      ])
    );
  });

  it.each([
    {
      attempt: 1,
      attemptId: "fixture",
      delayMs: 2000,
      phase: "scheduled" as const,
      remainingRetries: 2,
      retryAt: 2000,
      type: "model-retry" as const,
    },
    {
      attempt: 1,
      attemptId: "fixture",
      phase: "started" as const,
      remainingRetries: 1,
      type: "model-retry" as const,
    },
    {
      attempt: 1,
      attemptId: "fixture",
      phase: "stopped" as const,
      reason: "cancelled" as const,
      remainingRetries: 0 as const,
      type: "model-retry" as const,
    },
    {
      text: "must stay ephemeral",
      type: "assistant-output-delta" as const,
    },
    {
      calibration: { observations: 0, revision: 0 },
      currentRequest: {
        input: { basis: "heuristic" as const, marginTokens: 0, tokens: 0 },
        output: { basis: "heuristic" as const, marginTokens: 0, tokens: 0 },
        total: { basis: "heuristic" as const, marginTokens: 0, tokens: 0 },
      },
      type: "context-usage" as const,
    },
  ])("rejects $type at the durable recording boundary", (event) => {
    expect(() => recordDurableThreadEvent([], event)).toThrow(TypeError);
  });

  it("bypasses observer capture for stream events", async () => {
    const dispatcher = new ThreadEventDispatcher({
      history: () => [],
      hookRuntime: new AgentHookRuntime(),
      signal: () => undefined,
      threadKey: "stream-observer-capture",
    });
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();

    const captured = await dispatcher.captureObserverEvents(run, async () => {
      await dispatcher.emitObserverEvent(run, {
        text: "captured observer event",
        type: "assistant-reasoning",
      });
      dispatcher.emitStreamEvent(run, {
        text: "live delta",
        type: "assistant-output-delta",
      });
      return "done";
    });

    expect((await iterator.next()).value).toEqual({
      text: "live delta",
      type: "assistant-output-delta",
    });
    expect(captured).toMatchObject({
      events: [
        {
          text: "captured observer event",
          type: "assistant-reasoning",
        },
      ],
      value: "done",
    });

    captured.release();
    await iterator.return?.();
  });

  it("routes stream events through the emitTurnEvent ephemeral bypass", async () => {
    const host = createInMemoryHost();
    const dispatcher = new ThreadEventDispatcher({
      history: () => [],
      hookRuntime: new AgentHookRuntime(),
      signal: () => undefined,
      threadKey: "stream-turn-event-bypass",
    });
    const emitRunEvent = vi.spyOn(dispatcher, "emitRunEvent");
    const emitStreamEvent = vi.spyOn(dispatcher, "emitStreamEvent");
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();
    const recorded: AgentEvent[] = [];
    const event = {
      text: "live delta",
      type: "assistant-output-delta",
    } satisfies AgentEvent;

    await emitTurnEvent({
      attachmentStore: undefined,
      awaitBoundaries: false,
      durableEvents: [],
      event,
      events: dispatcher,
      executionHost: undefined,
      recordEvent: (recordedEvent) => recorded.push(recordedEvent),
      run,
      runtimeInput: createRuntimeInputState([]),
      state: new ThreadState({
        key: "stream-turn-event-bypass",
        store: host.store.threads,
      }),
      threadKey: "stream-turn-event-bypass",
    });

    expect((await iterator.next()).value).toEqual(event);
    expect(emitStreamEvent).toHaveBeenCalledWith(run, event);
    expect(emitRunEvent).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);

    await iterator.return?.();
  });
});

function createStreamThread(threadKey: string) {
  return new Agent({
    host: createInMemoryHost(),
    model: createStreamingMockLanguageModelV4([
      { stream: convertArrayToReadableStream(firstStreamChunks) },
      { stream: convertArrayToReadableStream(finalStreamChunks) },
    ]),
    tools: { lookup: lookupTool },
  }).thread(threadKey);
}

function createGenerateThread(threadKey: string) {
  return new Agent({
    model: createMockLanguageModelV4([
      generateFirstStep,
      mockLanguageModelV4Empty(),
    ]),
    tools: { lookup: lookupTool },
  }).thread(threadKey);
}

function committedTypes(events: readonly AgentEvent[]): AgentEvent["type"][] {
  return events
    .filter((event) => !isStreamAgentEvent(event))
    .map((event) => event.type);
}

async function collectAsync<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
