import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { defaultModelPromptMeasurementProfile } from "./context-gate";
import {
  ContextTokenCalibrationRegistry,
  ContextTokenMeter,
} from "./context-tokens";

const measurement = (messageUnits: number, fixedFingerprint = "fixed") => ({
  fixedFingerprint,
  fixedUnits: 50,
  messageUnits: [messageUnits],
  totalUnits: 50 + messageUnits,
});

describe("ContextTokenMeter", () => {
  it("deduplicates attempts and isolates provider/model calibration", () => {
    const registry = new ContextTokenCalibrationRegistry();
    const meter = new ContextTokenMeter(registry);
    meter.begin({
      attemptId: "a",
      fixedFingerprint: "fixed",
      measurement: measurement(100),
      scope: "p\0a",
    });
    meter.report("a", {
      attemptId: "a",
      inputTokens: 300,
      outputTokens: 20,
      type: "model-usage",
    });
    const revision = meter.snapshot().calibration.revision;
    meter.report("a", {
      attemptId: "a",
      inputTokens: 900,
      type: "model-usage",
    });
    expect(meter.snapshot().calibration.revision).toBe(revision);
    meter.begin({
      attemptId: "b",
      fixedFingerprint: "fixed",
      measurement: measurement(200),
      scope: "p\0b",
    });
    expect(meter.snapshot().calibration.observations).toBe(0);
  });

  it("learns marginal input only from consecutive equal fixed fingerprints", () => {
    const meter = new ContextTokenMeter(new ContextTokenCalibrationRegistry());
    meter.begin({
      attemptId: "a",
      fixedFingerprint: "fixed",
      measurement: measurement(100),
      scope: "p\0m",
    });
    meter.report("a", {
      attemptId: "a",
      inputTokens: 200,
      type: "model-usage",
    });
    meter.begin({
      attemptId: "b",
      fixedFingerprint: "fixed",
      measurement: measurement(200),
      scope: "p\0m",
    });
    meter.report("b", {
      attemptId: "b",
      inputTokens: 400,
      type: "model-usage",
    });
    expect(meter.snapshot().calibration.observations).toBe(2);
    meter.begin({
      attemptId: "c",
      fixedFingerprint: "changed",
      measurement: measurement(10, "changed"),
      scope: "p\0m",
    });
    expect(meter.snapshot().currentRequest.input.tokens).toBeLessThan(200);
  });

  it("rejects stale deltas and replaces estimates with reported usage", () => {
    const meter = new ContextTokenMeter(new ContextTokenCalibrationRegistry());
    meter.begin({
      attemptId: "new",
      fixedFingerprint: "fixed",
      measurement: measurement(10),
    });
    expect(meter.outputDelta("old", "ignored")).toBeUndefined();
    meter.outputDelta("new", "x".repeat(40));
    expect(meter.snapshot().currentRequest.output.basis).toBe("heuristic");
    meter.report("new", {
      attemptId: "new",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      type: "model-usage",
    });
    expect(meter.snapshot().currentRequest.total).toEqual({
      basis: "reported",
      marginTokens: 0,
      tokens: 15,
    });
  });

  it("derives a missing reported side from total usage", () => {
    const meter = new ContextTokenMeter(new ContextTokenCalibrationRegistry());
    meter.begin({
      attemptId: "partial",
      fixedFingerprint: "fixed",
      measurement: measurement(10),
      scope: "p\0partial",
    });
    meter.outputDelta("partial", "x".repeat(40));
    meter.report("partial", {
      attemptId: "partial",
      outputTokens: 25,
      totalTokens: 100,
      type: "model-usage",
    });

    expect(meter.snapshot().currentRequest).toEqual({
      input: { basis: "reported", marginTokens: 0, tokens: 75 },
      output: { basis: "reported", marginTokens: 0, tokens: 25 },
      total: { basis: "reported", marginTokens: 0, tokens: 100 },
    });
    expect(meter.snapshot().calibration.observations).toBe(1);
  });

  it("is invariant to stream delta fragmentation", () => {
    const registry = new ContextTokenCalibrationRegistry();
    const chunked = new ContextTokenMeter(registry);
    const whole = new ContextTokenMeter(registry);
    chunked.begin({
      attemptId: "chunked",
      fixedFingerprint: "fixed",
      measurement: measurement(10),
    });
    whole.begin({
      attemptId: "whole",
      fixedFingerprint: "fixed",
      measurement: measurement(10),
    });
    for (const character of "abcdefghij") {
      chunked.outputDelta("chunked", character);
    }
    whole.outputDelta("whole", "abcdefghij");

    expect(chunked.snapshot().currentRequest.output).toEqual(
      whole.snapshot().currentRequest.output
    );
  });

  it("learns both request-route and resolved-model scopes", () => {
    const registry = new ContextTokenCalibrationRegistry();
    const meter = new ContextTokenMeter(registry);
    meter.begin({
      attemptId: "routed",
      fixedFingerprint: "fixed",
      measurement: measurement(100),
      scope: "gateway\0route",
    });
    meter.report(
      "routed",
      {
        attemptId: "routed",
        inputTokens: 1500,
        modelId: "resolved",
        provider: "provider",
        type: "model-usage",
      },
      "provider\0resolved"
    );
    meter.begin({
      attemptId: "next",
      fixedFingerprint: "fixed",
      measurement: measurement(100),
      scope: "gateway\0route",
    });

    expect(meter.inputUpperBound()).toBeGreaterThanOrEqual(1500);
  });

  it("makes a large first same-fixed observation conservative", () => {
    const meter = new ContextTokenMeter(new ContextTokenCalibrationRegistry());
    meter.begin({
      attemptId: "large",
      fixedFingerprint: "fixed",
      measurement: measurement(100),
      scope: "p\0large",
    });
    meter.report("large", {
      attemptId: "large",
      inputTokens: 1500,
      type: "model-usage",
    });
    meter.begin({
      attemptId: "next",
      fixedFingerprint: "fixed",
      measurement: measurement(100),
      scope: "p\0large",
    });
    expect(meter.inputUpperBound()).toBeGreaterThanOrEqual(1500);
  });

  it("never lowers the learned marginal safety slope", () => {
    const meter = new ContextTokenMeter(new ContextTokenCalibrationRegistry());
    for (const [attemptId, fingerprint, units, inputTokens] of [
      ["a1", "dense", 100, 1050],
      ["a2", "dense", 200, 2050],
      ["b1", "sparse", 100, 150],
      ["b2", "sparse", 200, 250],
    ] as const) {
      meter.begin({
        attemptId,
        fixedFingerprint: fingerprint,
        measurement: measurement(units, fingerprint),
        scope: "p\0mixed",
      });
      meter.report(attemptId, {
        attemptId,
        inputTokens,
        type: "model-usage",
      });
    }
    meter.begin({
      attemptId: "next",
      fixedFingerprint: "dense",
      measurement: measurement(100, "dense"),
      scope: "p\0mixed",
    });

    expect(meter.inputUpperBound()).toBeGreaterThanOrEqual(1050);
  });

  it("does not broadcast CJK calibration density to ASCII and tool results", () => {
    // Given
    const registry = new ContextTokenCalibrationRegistry();
    const meter = new ContextTokenMeter(registry);
    const instructions = "i".repeat(400);
    const scope = "prov\0mod";
    const begin = (attemptId: string, messages: readonly ModelMessage[]) => {
      const prompt = defaultModelPromptMeasurementProfile.measurePrompt({
        instructions,
        messages,
      });
      meter.begin({
        attemptId,
        fixedFingerprint: prompt.fixedFingerprint,
        measurement: prompt,
        scope,
      });
    };
    const asciiTraining: readonly ModelMessage[] = [
      { content: "a".repeat(372), role: "user" },
    ];
    const cjkTraining: readonly ModelMessage[] = [
      ...asciiTraining,
      { content: "日".repeat(372), role: "user" },
    ];
    const current: readonly ModelMessage[] = [
      { content: "a".repeat(332), role: "user" },
      { content: "a".repeat(332), role: "user" },
      { content: "a".repeat(332), role: "user" },
      {
        content: [
          {
            output: { type: "text", value: "x".repeat(400) },
            toolCallId: "call-1",
            toolName: "read_file",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      { content: "日".repeat(252), role: "user" },
    ];
    begin("train-ascii", asciiTraining);
    meter.report("train-ascii", {
      attemptId: "train-ascii",
      inputTokens: 200,
      type: "model-usage",
    });
    begin("train-cjk", cjkTraining);
    meter.report("train-cjk", {
      attemptId: "train-cjk",
      inputTokens: 400,
      type: "model-usage",
    });
    begin("current", current);

    // When
    const snapshot = meter.snapshot();
    const upperBound = meter.inputUpperBound();

    // Then
    expect(snapshot.calibration.observations).toBe(2);
    expect.soft(snapshot.currentRequest.input).toEqual({
      basis: "calibrated",
      marginTokens: 143,
      tokens: 711,
    });
    expect.soft(upperBound).toBe(854);
  });

  it("keeps a repeated CJK prompt above its reported provider input", () => {
    // Given
    const meter = new ContextTokenMeter(new ContextTokenCalibrationRegistry());
    const messages: readonly ModelMessage[] = [
      { content: "日".repeat(372), role: "user" },
    ];
    const prompt = defaultModelPromptMeasurementProfile.measurePrompt({
      instructions: "i".repeat(400),
      messages,
    });
    meter.begin({
      attemptId: "reported",
      fixedFingerprint: prompt.fixedFingerprint,
      measurement: prompt,
      scope: "prov\0cjk-repeat",
    });
    meter.report("reported", {
      attemptId: "reported",
      inputTokens: 900,
      type: "model-usage",
    });
    meter.begin({
      attemptId: "repeat",
      fixedFingerprint: prompt.fixedFingerprint,
      measurement: prompt,
      scope: "prov\0cjk-repeat",
    });

    // When
    const upperBound = meter.inputUpperBound();

    // Then
    expect(upperBound).toBeGreaterThanOrEqual(900);
  });

  it("pins calibration values in an immutable view", () => {
    const meter = new ContextTokenMeter(new ContextTokenCalibrationRegistry());
    meter.begin({
      attemptId: "a1",
      fixedFingerprint: "fixed",
      measurement: measurement(100),
      scope: "p\0pin",
    });
    meter.report("a1", {
      attemptId: "a1",
      inputTokens: 150,
      type: "model-usage",
    });
    const view = meter.view();
    const pinned = view.estimateMessageUnits([100]);
    meter.begin({
      attemptId: "a2",
      fixedFingerprint: "fixed",
      measurement: measurement(200),
      scope: "p\0pin",
    });
    meter.report("a2", {
      attemptId: "a2",
      inputTokens: 1050,
      type: "model-usage",
    });

    expect(view.estimateMessageUnits([100])).toEqual(pinned);
    expect(meter.estimateMessageUnits([100])[0]).toBeGreaterThan(
      pinned[0] ?? 0
    );
  });

  it("labels each estimated side only from side-specific evidence", () => {
    const inputOnly = new ContextTokenMeter(
      new ContextTokenCalibrationRegistry()
    );
    inputOnly.begin({
      attemptId: "input",
      fixedFingerprint: "fixed",
      measurement: measurement(10),
      scope: "p\0input",
    });
    inputOnly.outputDelta("input", "output");
    inputOnly.report("input", {
      attemptId: "input",
      inputTokens: 60,
      type: "model-usage",
    });
    expect(inputOnly.snapshot().currentRequest.output.basis).toBe("heuristic");
    expect(inputOnly.snapshot().currentRequest.total.basis).toBe("heuristic");

    const outputOnly = new ContextTokenMeter(
      new ContextTokenCalibrationRegistry()
    );
    outputOnly.begin({
      attemptId: "output",
      fixedFingerprint: "fixed",
      measurement: measurement(10),
      scope: "p\0output",
    });
    outputOnly.outputDelta("output", "output");
    outputOnly.report("output", {
      attemptId: "output",
      outputTokens: 6,
      type: "model-usage",
    });
    expect(outputOnly.snapshot().currentRequest.input.basis).toBe("heuristic");
    expect(outputOnly.snapshot().currentRequest.total.basis).toBe("heuristic");
  });
});
