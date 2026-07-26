import { describe, expect, it } from "vitest";
import type { ExtensionJsonValue } from "./extensions";
import {
  createProviderObservationFetch,
  type ProviderObservationEmitter,
} from "./provider-observation";

interface RecordedEvent {
  readonly payload: ExtensionJsonValue;
  readonly type: string;
}

function createRecorder(): {
  readonly emitter: ProviderObservationEmitter;
  readonly events: RecordedEvent[];
} {
  const events: RecordedEvent[] = [];
  return {
    emitter: {
      current: (type, payload) => {
        events.push({ payload, type });
      },
    },
    events,
  };
}

describe("provider observation fetch", () => {
  it("emits redacted request and safelisted response events", async () => {
    // Given
    const { emitter, events } = createRecorder();
    const observed = createProviderObservationFetch(emitter, () =>
      Promise.resolve(
        new Response("{}", {
          headers: {
            authorization: "Bearer secret",
            "content-type": "application/json",
            "set-cookie": "session=1",
            "x-ratelimit-remaining": "42",
            "x-request-id": "req-1",
          },
          status: 200,
        })
      )
    );

    // When
    const response = await observed(
      "https://user:pass@gateway.example/v1/chat?api-key=leak#token=fragment",
      { body: '{"secret":true}', method: "post" }
    );

    // Then
    expect(response.status).toBe(200);
    expect(events).toEqual([
      {
        payload: {
          method: "POST",
          url: "https://gateway.example/v1/chat",
        },
        type: "provider:request",
      },
      {
        payload: {
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "42",
            "x-request-id": "req-1",
          },
          status: 200,
          url: "https://gateway.example/v1/chat",
        },
        type: "provider:response",
      },
    ]);
  });

  it("emits provider:error and rethrows on network failure", async () => {
    // Given
    const { emitter, events } = createRecorder();
    const observed = createProviderObservationFetch(emitter, () =>
      Promise.reject(new Error("socket hang up"))
    );

    // When / Then
    await expect(observed("https://gateway.example/v1/chat")).rejects.toThrow(
      "socket hang up"
    );
    expect(events).toEqual([
      {
        payload: { method: "GET", url: "https://gateway.example/v1/chat" },
        type: "provider:request",
      },
      {
        payload: {
          message: "socket hang up",
          url: "https://gateway.example/v1/chat",
        },
        type: "provider:error",
      },
    ]);
  });

  it("never breaks traffic when the emitter is unbound or throws", async () => {
    // Given
    const emitter: ProviderObservationEmitter = {};
    const observed = createProviderObservationFetch(emitter, () =>
      Promise.resolve(new Response("ok"))
    );

    // When
    const unbound = await observed("https://gateway.example/v1/models");
    emitter.current = () => {
      throw new Error("observer exploded");
    };
    const throwing = await observed("https://gateway.example/v1/models");

    // Then
    expect(unbound.status).toBe(200);
    expect(throwing.status).toBe(200);
  });
});
