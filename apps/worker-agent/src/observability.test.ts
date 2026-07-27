import type { AgentEvent } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";

import {
  createTurnEventCollector,
  createTurnObservabilityHooks,
  createTurnObservabilityInstrumentation,
  describeEvent,
  type TurnObservabilityEntry,
} from "./observability";

describe("describeEvent", () => {
  it("captures tool events with the tool name", () => {
    expect(
      describeEvent(
        { type: "tool-call", input: {}, toolCallId: "1", toolName: "search" },
        "production"
      )
    ).toEqual({
      event: "tool-call",
      label: "production",
      toolCallId: "1",
      toolName: "search",
    });
  });

  it("captures turn-error with its message", () => {
    expect(
      describeEvent({ type: "turn-error", message: "boom" }, "dev")
    ).toEqual({ event: "turn-error", label: "dev", message: "boom" });
  });

  it("captures lifecycle events without text payloads", () => {
    expect(describeEvent({ type: "turn-end" })).toEqual({ event: "turn-end" });
  });

  it("ignores user-authored text events to avoid leaking content", () => {
    expect(
      describeEvent({ type: "user-input", text: "secret" })
    ).toBeUndefined();
    expect(
      describeEvent({ type: "assistant-output", text: "secret" })
    ).toBeUndefined();
  });
});

describe("createTurnEventCollector", () => {
  it("summarizes steps and tool calls for a wide event", () => {
    const collector = createTurnEventCollector();
    collector.record({ event: "turn-start", label: "dev" });
    collector.record({ event: "step-start", label: "dev" });
    collector.record({
      event: "tool-call",
      label: "dev",
      toolName: "send_message",
    });
    collector.record({ event: "step-end", label: "dev" });
    collector.record({ event: "turn-end", label: "dev" });

    expect(collector.summary()).toEqual({
      errors: [],
      steps: 1,
      toolCalls: ["send_message"],
    });
  });
});

describe("createTurnObservabilityInstrumentation", () => {
  it("logs described events without changing the stream", async () => {
    const entries: TurnObservabilityEntry[] = [];
    const instrumentation = createTurnObservabilityInstrumentation({
      label: "dev",
      log: (entry) => entries.push(entry),
    });
    const sourceEvents: AgentEvent[] = [
      {
        type: "tool-result",
        output: {},
        toolCallId: "1",
        toolName: "x",
      },
      { type: "assistant-output", text: "hi" },
    ];
    const wrapped = instrumentation.wrapTurn(
      {
        async *events() {
          yield* sourceEvents;
        },
        runId: "run-1",
      },
      {
        operation: "send",
        runId: "run-1",
        threadKey: "test",
      }
    );
    const observed: AgentEvent[] = [];
    for await (const event of wrapped.events()) {
      observed.push(event);
    }

    expect(observed).toEqual(sourceEvents);
    expect(wrapped.runId).toBe("run-1");
    expect(entries).toEqual([
      {
        event: "tool-result",
        label: "dev",
        toolCallId: "1",
        toolName: "x",
      },
    ]);
  });

  it("preserves durable runId from the underlying turn", () => {
    const instrumentation = createTurnObservabilityInstrumentation();
    const wrapped = instrumentation.wrapTurn(
      {
        events() {
          return {
            async *[Symbol.asyncIterator]() {
              await Promise.resolve();
              yield { type: "turn-end" } satisfies AgentEvent;
            },
          };
        },
        runId: "durable-42",
      },
      { operation: "send", threadKey: "t", runId: "durable-42" }
    );
    expect(wrapped.runId).toBe("durable-42");
  });
});

describe("createTurnObservabilityHooks", () => {
  it("records tool attempts before execution for failed tools", async () => {
    const collector = createTurnEventCollector();
    const hooks = createTurnObservabilityHooks({
      label: "prod",
      log: collector.record,
    });

    await hooks.beforeToolExecution?.(
      {
        attempt: 1,
        idempotencyKey: "run:call-1",
        input: {},
        policy: "manual-recovery",
        toolCallId: "call-1",
        toolName: "send_message",
      },
      {
        history: [],
        signal: new AbortController().signal,
        threadKey: "thread",
      }
    );

    // No public tool-call event emitted (tool failed / needs recovery).
    expect(collector.summary().toolCalls).toEqual(["send_message"]);
  });

  it("dedupes attempt and completed public tool-call for the same id", () => {
    const collector = createTurnEventCollector();
    collector.record({
      event: "tool-call",
      toolCallId: "call-1",
      toolName: "search",
    });
    collector.record({
      event: "tool-call",
      toolCallId: "call-1",
      toolName: "search",
    });
    expect(collector.summary().toolCalls).toEqual(["search"]);
  });
});
