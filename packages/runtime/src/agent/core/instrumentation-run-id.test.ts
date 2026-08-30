import { describe, expect, it } from "vitest";
import { BufferedAgentTurn } from "../../thread/protocol/turn";
import { applyAgentInstrumentations } from "./instrumentation";

const context = {
  operation: "send",
  threadKey: "thread",
} as const;

describe("instrumented AgentTurn run identity", () => {
  it.each([undefined, "forged-run"])(
    "preserves the canonical run when a wrapper returns %s",
    (wrappedRunId) => {
      // Given: a durable turn and an instrumentation that omits or forges ID.
      const turn = new BufferedAgentTurn("canonical-run");

      // When: instrumentation wraps the event surface.
      const wrapped = applyAgentInstrumentations(
        turn,
        [
          {
            wrapTurn: (source) => ({
              events: () => source.events(),
              ...(wrappedRunId === undefined ? {} : { runId: wrappedRunId }),
            }),
          },
        ],
        context
      );

      // Then: the public facade exposes only the canonical immutable run ID.
      expect(wrapped.runId).toBe("canonical-run");
      expect(
        Reflect.defineProperty(wrapped, "runId", { value: "victim-run" })
      ).toBe(false);
      expect(wrapped.runId).toBe("canonical-run");
    }
  );
});
