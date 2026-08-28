import { describe, expect, it } from "vitest";
import { createCelldTestStorage } from "../../../packages/runtime/src/platform/celld/celld-test-storage";
import { RealAgent } from "../worker/real-agent.js";

function createState(storage = createCelldTestStorage()) {
  const waits: Promise<unknown>[] = [];
  return {
    state: {
      storage,
      waitUntil(promise: Promise<unknown>): void {
        waits.push(promise);
      },
    },
    waits,
  };
}

async function call(
  instance: RealAgent,
  scenario: string,
  phase = "run",
  token = `token-${scenario}`
): Promise<Record<string, unknown>> {
  const response = await instance.fetch(
    new Request("http://worker/real-agent", {
      body: JSON.stringify({ phase, scenario, token }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  expect(response.status).toBe(200);
  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new TypeError("Expected a JSON object response.");
  }
  return Object.fromEntries(Object.entries(payload));
}

describe("real-agent Celld worker", () => {
  it("executes a checkpointed tool side effect exactly once across reconstruction", async () => {
    // Given a Celld-compatible durable store and an execution token
    const { state } = createState();

    // When the execution response is lost and the object is reconstructed
    const first = await call(new RealAgent(state), "tool-checkpoint");
    const recovered = await call(
      new RealAgent(state),
      "tool-checkpoint",
      "verify"
    );

    // Then the same durable run has one checkpointed side effect
    expect(first).toMatchObject({ passed: true, sideEffectCount: 1 });
    expect(recovered).toMatchObject({
      checkpointed: true,
      passed: true,
      sideEffectCount: 1,
    });
  });

  it("preserves send, steer, follow-up, and notify ordering", async () => {
    // Given one real agent thread
    const { state } = createState();

    // When all input APIs are exercised while events are continuously consumed
    const result = await call(new RealAgent(state), "input-ordering");

    // Then each machine-consumed source appears in its required order
    expect(result).toMatchObject({
      inputSources: ["send", "steer", "follow-up", "follow-up", "notify"],
      passed: true,
    });
  });

  it("keeps automatic and manual compaction continuity after response loss", async () => {
    // Given history containing durable markers
    const { state } = createState();

    // When compaction runs and a reconstructed object verifies the lost response
    const compacted = await call(new RealAgent(state), "compaction");
    const recovered = await call(new RealAgent(state), "compaction", "verify");

    // Then both compaction modes ran and all markers remain model-visible
    expect(compacted).toMatchObject({
      automaticCompactions: 1,
      manualStatus: "compacted",
      passed: true,
    });
    expect(recovered).toMatchObject({
      markers: ["CMP-A", "CMP-B", "CMP-C"],
      passed: true,
    });
  });

  it("round-trips large chunked history and payload markers", async () => {
    // Given payloads larger than the configured storage row budget
    const { state } = createState();

    // When the real agent persists and reloads the history
    const result = await call(new RealAgent(state), "large-history");

    // Then chunk rows exist and every boundary marker is intact
    expect(result).toMatchObject({
      chunked: true,
      markers: ["LARGE-00", "LARGE-01", "LARGE-02", "LARGE-03"],
      passed: true,
      payloadBytes: 32_768,
    });
  });

  it("normalizes, persists, and hydrates an attachment", async () => {
    // Given a valid inline PNG attachment
    const { state } = createState();

    // When the real agent sends it through Celld storage
    const result = await call(new RealAgent(state), "attachment");

    // Then durable input contains a ref and the model receives the original bytes
    expect(result).toMatchObject({
      hydratedByteLength: 68,
      hydratedMediaType: "image/png",
      normalized: true,
      passed: true,
      persistedReference: true,
    });
  });
});
