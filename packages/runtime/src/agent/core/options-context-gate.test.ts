import { describe, expect, it } from "vitest";
import type { ContextBudgetSource } from "../../llm/context-gate";
import { createCallbackModel } from "../../testing/test-fixtures";
import { Agent, createAgent } from "./agent";
import { assertAgentOptions } from "./options";

const model = () => createCallbackModel(() => []);
const expectInvalid = (contextGate: unknown, message: string): void => {
  expect(() => assertAgentOptions({ contextGate, model: model() })).toThrow(
    message
  );
};

describe("AgentOptions.contextGate", () => {
  it("rejects a non-function maxInputTokens", () => {
    expectInvalid(
      { maxInputTokens: 1 },
      "Agent: options.contextGate.maxInputTokens must be a function."
    );
  });

  it("requires maxInputTokens", () => {
    expectInvalid(
      {},
      "Agent: options.contextGate.maxInputTokens must be a function."
    );
  });

  it("rejects a function gate", () => {
    expectInvalid(() => 1, "Agent: options.contextGate must be an object.");
  });

  it("rejects a non-function estimateTokens", () => {
    expectInvalid(
      { estimateTokens: 5, maxInputTokens: (): number => 1 },
      "Agent: options.contextGate.estimateTokens must be a function."
    );
  });

  it("rejects a negative bufferTokens", () => {
    expectInvalid(
      { bufferTokens: -1, maxInputTokens: (): number => 1 },
      "Agent: options.contextGate.bufferTokens must be a non-negative integer."
    );
  });

  it("rejects a fractional bufferTokens", () => {
    expectInvalid(
      { bufferTokens: 1.5, maxInputTokens: (): number => 1 },
      "Agent: options.contextGate.bufferTokens must be a non-negative integer."
    );
  });

  it("rejects an invalid onOverflow", () => {
    expectInvalid(
      { maxInputTokens: (): number => 1, onOverflow: "retry" },
      'Agent: options.contextGate.onOverflow must be "compact" or "error".'
    );
  });

  it("accepts all supported budget properties", () => {
    expect(() =>
      assertAgentOptions({
        contextGate: {
          bufferTokens: 0,
          estimateTokens: () => 1,
          maxInputTokens: () => 1,
          onOverflow: "error",
        },
        model: model(),
      })
    ).not.toThrow();
  });

  it("reads nested contextGate capabilities once in Agent", () => {
    const contextGate: ContextBudgetSource = { maxInputTokens: () => 1 };
    let reads = 0;
    Object.defineProperty(contextGate, "maxInputTokens", {
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) {
          throw new Error("NESTED_SECRET_SENTINEL");
        }
        return () => 100;
      },
    });

    expect(() => new Agent({ contextGate, model: model() })).not.toThrow();
    expect(reads).toBe(1);
  });

  it("reads nested contextGate capabilities once in createAgent", async () => {
    const contextGate: ContextBudgetSource = { maxInputTokens: () => 1 };
    let reads = 0;
    Object.defineProperty(contextGate, "maxInputTokens", {
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) {
          throw new Error("NESTED_SECRET_SENTINEL");
        }
        return () => 100;
      },
    });

    await expect(
      createAgent({ contextGate, model: model() })
    ).resolves.toBeInstanceOf(Agent);
    expect(reads).toBe(1);
  });
});
