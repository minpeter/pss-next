import { describe, expect, it } from "vitest";
import { collect } from "../../thread/handle/test-support";
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

  it("hides producer methods from the first instrumentation", () => {
    // Given: a producer turn and instrumentation that inspects its input.
    const turn = new BufferedAgentTurn("canonical-run");
    let exposedClose: unknown;
    let exposedEmit: unknown;

    // When: the first instrumentation receives its turn.
    applyAgentInstrumentations(
      turn,
      [
        {
          wrapTurn: (source) => {
            exposedClose = Reflect.get(source, "close");
            exposedEmit = Reflect.get(source, "emit");
            return source;
          },
        },
      ],
      context
    );

    // Then: the consumer facade exposes no producer capability.
    expect(exposedClose).toBeUndefined();
    expect(exposedEmit).toBeUndefined();
  });

  it("does not read wrapper run IDs between instrumentations", async () => {
    // Given: a closed producer turn and a hostile first wrapper runId getter.
    const turn = new BufferedAgentTurn("canonical-run");
    turn.emit({ type: "turn-start" });
    turn.close();
    let hostileReads = 0;

    // When: a second instrumentation observes the first wrapper.
    const wrapped = applyAgentInstrumentations(
      turn,
      [
        {
          wrapTurn: (source) => ({
            events: () => source.events(),
            get runId(): string {
              hostileReads += 1;
              throw new Error("hostile runId getter invoked");
            },
          }),
        },
        {
          wrapTurn: (source) => {
            expect(source.runId).toBe("canonical-run");
            return source;
          },
        },
      ],
      context
    );

    // Then: the canonical facade preserves identity and the event stream.
    await expect(collect(wrapped)).resolves.toEqual([{ type: "turn-start" }]);
    expect(hostileReads).toBe(0);
    expect(wrapped.runId).toBe("canonical-run");
  });
});
