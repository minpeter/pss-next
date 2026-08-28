import { describe, expect, it } from "vitest";
import { FaultControlState } from "./fault-proxy-control";

describe("FaultControlState", () => {
  it("creates immutable generations and bounds synthetic failures", () => {
    // Given
    const state = new FaultControlState(() => 1000);
    const first = state.install({ count: 1, kind: "http_500", key: "/b/k" });

    // When
    const matched = state.decide({ headers: {}, key: "/b/k", method: "GET" });
    state.complete(matched, { error: null, status: 500 });
    const exhausted = state.decide({ headers: {}, key: "/b/k", method: "GET" });
    const second = state.install({ kind: "pass" });

    // Then
    expect(first).toEqual({
      id: 1,
      installedAtMs: 1000,
      rule: { count: 1, kind: "http_500", key: "/b/k" },
    });
    expect(matched).toMatchObject({ kind: "synthetic", status: 500 });
    expect(exhausted).toEqual({ generation: 1, kind: "upstream" });
    expect(second.id).toBe(2);
    expect(first.rule.kind).toBe("http_500");
  });

  it("makes a written key invisible for the configured number of reads", () => {
    // Given
    const state = new FaultControlState(() => 10);
    state.install({ count: 1, key: "/bucket/key", kind: "read_after_write" });
    const write = state.decide({
      headers: {},
      key: "/bucket/key",
      method: "PUT",
    });
    state.complete(write, { error: null, status: 200 });

    // When
    const hidden = state.decide({
      headers: {},
      key: "/bucket/key",
      method: "GET",
    });
    state.complete(hidden, { error: null, status: 404 });
    const visible = state.decide({
      headers: {},
      key: "/bucket/key",
      method: "GET",
    });

    // Then
    expect(hidden).toMatchObject({ kind: "synthetic", status: 404 });
    expect(visible.kind).toBe("upstream");
  });

  it("captures decision outcomes without exposing mutable state", () => {
    // Given
    const state = new FaultControlState(() => 20);
    state.install({
      count: 1,
      kind: "throttle_429",
      key: "/b/k",
      retryAfterSeconds: 3,
    });
    const decision = state.decide({ headers: {}, key: "/b/k", method: "GET" });

    // When
    state.complete(decision, { error: null, status: 429 });
    const events = state.events();

    // Then
    expect(events).toEqual([
      {
        error: null,
        generation: 1,
        key: "/b/k",
        method: "GET",
        status: 429,
        synthetic: true,
        upstreamCalled: false,
      },
    ]);
    expect(Object.isFrozen(events[0])).toBe(true);
  });
});
