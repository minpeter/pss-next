import { describe, expect, it } from "vitest";
import {
  bootstrapCell,
  extractFingerprint,
  pairedDelta,
} from "./stats";

describe("extractFingerprint", () => {
  it("reads system_fingerprint from a response body", () => {
    expect(
      extractFingerprint({
        system_fingerprint: "fp_a18b46594c_prod0820_fp8_kvcache_20260402",
      })
    ).toBe("fp_a18b46594c_prod0820_fp8_kvcache_20260402");
  });

  it("returns null when the provider omits it", () => {
    expect(extractFingerprint({})).toBeNull();
    expect(extractFingerprint(null)).toBeNull();
    expect(extractFingerprint("fp_x")).toBeNull();
    expect(extractFingerprint({ system_fingerprint: 7 })).toBeNull();
  });
});

describe("bootstrapCell", () => {
  it("reports zero spread for a unanimous cell", () => {
    const stats = bootstrapCell(Array.from({ length: 24 }, () => true));
    expect(stats.attempts).toBe(24);
    expect(stats.passed).toBe(24);
    expect(stats.rate).toBe(1);
    expect(stats.se).toBe(0);
    expect(stats.ciLow).toBe(1);
    expect(stats.ciHigh).toBe(1);
  });

  it("centers on the observed rate with binomial-scale spread", () => {
    const passes = [
      ...Array.from({ length: 12 }, () => true),
      ...Array.from({ length: 12 }, () => false),
    ];
    const stats = bootstrapCell(passes);
    expect(stats.rate).toBe(0.5);
    // sqrt(0.25/24) ~ 0.102; bootstrap std should land near it.
    expect(stats.se).toBeGreaterThan(0.07);
    expect(stats.se).toBeLessThan(0.14);
    expect(stats.ciLow).toBeLessThan(0.5);
    expect(stats.ciHigh).toBeGreaterThan(0.5);
    expect(stats.ciLow).toBeGreaterThanOrEqual(0);
    expect(stats.ciHigh).toBeLessThanOrEqual(1);
  });

  it("is deterministic for a fixed seed", () => {
    const passes = [true, false, true, true, false, true, false];
    const first = bootstrapCell(passes);
    const second = bootstrapCell(passes);
    expect(first).toEqual(second);
  });
});

describe("pairedDelta", () => {
  it("reports zero delta for identical outcomes", () => {
    const outcomes = [true, false, true, true];
    const stats = pairedDelta(outcomes, outcomes);
    expect(stats.delta).toBe(0);
    expect(stats.se).toBe(0);
    expect(stats.ciLow).toBe(0);
    expect(stats.ciHigh).toBe(0);
    expect(stats.pairs).toBe(4);
  });

  it("reports a perfect delta when one side always wins", () => {
    const stats = pairedDelta(
      [true, true, true],
      [false, false, false]
    );
    expect(stats.delta).toBe(1);
    expect(stats.ciLow).toBe(1);
    expect(stats.ciHigh).toBe(1);
  });

  it("drops pairs where either side is unscored", () => {
    const stats = pairedDelta(
      [true, null, true],
      [false, false, null]
    );
    expect(stats.pairs).toBe(1);
    expect(stats.delta).toBe(1);
  });

  it("gives a CI that contains the observed delta for mixed pairs", () => {
    const stats = pairedDelta(
      [true, true, false, true, false, true, false, true],
      [false, true, false, false, false, true, false, false]
    );
    expect(stats.pairs).toBe(8);
    expect(stats.ciLow).toBeLessThanOrEqual(stats.delta);
    expect(stats.ciHigh).toBeGreaterThanOrEqual(stats.delta);
  });
});
