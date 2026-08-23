import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  ContextTokenCalibrationRegistry,
  ContextTokenMeter,
} from "../../llm/context-tokens";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { compactionTokenAccounting } from "./auto-compaction-token-accounting";

describe("compaction token accounting", () => {
  it("falls back to instruction measurement when the meter has no active attempt", () => {
    const history: readonly ModelMessage[] = [
      { content: "old context", role: "user" },
      assistantMessage("done"),
    ];
    const instructions = "fixed instruction ".repeat(200);
    const meter = new ContextTokenMeter(new ContextTokenCalibrationRegistry());

    const accounting = compactionTokenAccounting({
      estimatedHistory: history,
      hydratedModelContext: history,
      meterView: meter.view(),
      model: {
        instructions,
        model: createCallbackModel(() => [assistantMessage("unused")]),
      },
      observedInput: [],
      observedOutput: [],
    });
    const expectedFixedTokens = accounting.estimate([
      { content: instructions, role: "system" },
    ]);

    expect(expectedFixedTokens).toBeGreaterThan(0);
    expect(accounting.fixedTokens).toBe(expectedFixedTokens);
    expect(accounting.estimatedContextTokens).toBe(
      accounting.estimate(history) + expectedFixedTokens
    );
  });

  it("does not add instruction tokens on top of a calibrated fixed prompt", () => {
    const history: readonly ModelMessage[] = [
      { content: "old context", role: "user" },
      assistantMessage("done"),
    ];
    const instructions = "fixed instruction ".repeat(200);
    const meter = new ContextTokenMeter(new ContextTokenCalibrationRegistry());
    meter.begin({
      attemptId: "attempt",
      fixedFingerprint: "fixed",
      measurement: {
        fixedFingerprint: "fixed",
        fixedUnits: 40,
        messageUnits: [10, 10],
        totalUnits: 60,
      },
    });

    const accounting = compactionTokenAccounting({
      estimatedHistory: history,
      hydratedModelContext: history,
      meterView: meter.view(),
      model: {
        instructions,
        model: createCallbackModel(() => [assistantMessage("unused")]),
      },
      observedInput: [],
      observedOutput: [],
    });
    const instructionEstimate = accounting.estimate([
      { content: instructions, role: "system" },
    ]);

    expect(instructionEstimate).toBeGreaterThan(0);
    expect(accounting.fixedTokens).toBe(40);
    expect(accounting.estimatedContextTokens).toBe(
      accounting.estimate(history) + 40
    );
  });
});
