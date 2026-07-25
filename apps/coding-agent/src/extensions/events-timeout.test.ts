import type { AgentEvent } from "@minpeter/pss-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodingAgentExtensionInstrumentation } from "./events";
import type { CodingAgentExtensionServices } from "./types";

afterEach(() => {
  vi.useRealTimers();
});

describe("extension event timeouts", () => {
  it("times out a never-settling event handler", async () => {
    vi.useFakeTimers();
    const services = {} as CodingAgentExtensionServices;
    const instrumentation = createCodingAgentExtensionInstrumentation(
      [
        {
          extensionId: "hang",
          type: "turn-start",
          invoke: () => new Promise<void>(() => undefined),
        },
      ],
      new AbortController().signal,
      () => services,
      20
    );

    const wrapped = instrumentation.wrapTurn(
      {
        async *events() {
          yield { type: "turn-start" } satisfies AgentEvent;
        },
        runId: "run-1",
      },
      { operation: "send", threadKey: "t1", runId: "run-1" }
    );

    const iteration = (async () => {
      for await (const _event of wrapped.events()) {
        // hang on first event handler
      }
    })();

    const expectation = expect(iteration).rejects.toMatchObject({
      extensionId: "hang",
      phase: "event",
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
  });

  it("preserves turn runId on the wrapped turn", () => {
    const instrumentation = createCodingAgentExtensionInstrumentation(
      [],
      new AbortController().signal,
      () => ({}) as CodingAgentExtensionServices
    );
    const wrapped = instrumentation.wrapTurn(
      {
        async *events() {
          yield { type: "turn-end" } satisfies AgentEvent;
        },
        runId: "durable-run",
      },
      { operation: "send", threadKey: "t1" }
    );
    expect(wrapped.runId).toBe("durable-run");
  });
});
