import { describe, expect, it } from "vitest";
import {
  conflictAppendSuffix,
  equalSnapshot,
  snapshotSuffix,
} from "./snapshot-equal";

describe("snapshot equality", () => {
  it("compares nested arrays and records structurally", () => {
    // Given
    const left = [{ content: ["text", { value: 1 }], role: "assistant" }];
    const equal = [{ content: ["text", { value: 1 }], role: "assistant" }];
    const changed = [{ content: ["text", { value: 2 }], role: "assistant" }];

    // When / Then
    expect(equalSnapshot(left, equal)).toBe(true);
    expect(equalSnapshot(left, changed)).toBe(false);
  });

  it("distinguishes a missing record property from an undefined property", () => {
    // Given
    const present = { content: undefined, role: "assistant" };
    const missing = { role: "assistant" };

    // When / Then
    expect(equalSnapshot(present, missing)).toBe(false);
  });

  it("compares byte-oriented snapshot values", () => {
    // Given
    const left = new Uint8Array([1, 2, 3]);
    const equal = new Uint8Array([1, 2, 3]);
    const changed = new Uint8Array([1, 2, 4]);

    // When / Then
    expect(equalSnapshot(left, equal)).toBe(true);
    expect(equalSnapshot(left, changed)).toBe(false);
  });

  it("rejects non-plain prototypes while ignoring symbol metadata", () => {
    // Given
    const metadata = Symbol("metadata");
    const left = { content: "same", [metadata]: "left" };
    const right = { content: "same", [metadata]: "right" };
    const nonPlain = Object.setPrototypeOf(
      { content: "same" },
      { inherited: true }
    );

    // When / Then
    expect(equalSnapshot(left, right)).toBe(true);
    expect(equalSnapshot(left, nonPlain)).toBe(false);
  });

  it("short-circuits identity before traversing cyclic values", () => {
    // Given
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    // When / Then
    expect(equalSnapshot(cyclic, cyclic)).toBe(true);
  });
});

describe("snapshot suffixes", () => {
  it("preserves only the local tail after linearly comparable histories", () => {
    // Given
    const base = [{ content: "base", role: "user" }];
    const remote = [...base, { content: "remote", role: "assistant" }];
    const local = [...remote, { content: "local", role: "user" }];

    // When
    const prefixSuffix = snapshotSuffix(base, local);
    const conflictSuffix = conflictAppendSuffix(base, local, remote);

    // Then
    expect(prefixSuffix).toEqual(local.slice(1));
    expect(conflictSuffix).toEqual(local.slice(2));
  });

  it("rejects suffix preservation for divergent histories", () => {
    // Given
    const attempted = [{ content: "base", role: "user" }];
    const local = [...attempted, { content: "local", role: "assistant" }];
    const remote = [{ content: "changed", role: "user" }];

    // When / Then
    expect(conflictAppendSuffix(attempted, local, remote)).toEqual([]);
  });
});
