import { jsonSchema, tool } from "ai";
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

    expect(live.map((event) => event.type)).toEqual(expectedLiveTypes);
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

  it("rejects stream events at the durable recording boundary", () => {
    expect(() =>
      recordDurableThreadEvent([], {
        text: "must stay ephemeral",
        type: "assistant-output-delta",
      })
    ).toThrow(TypeError);
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
