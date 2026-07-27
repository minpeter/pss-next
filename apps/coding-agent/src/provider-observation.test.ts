import { describe, expect, it } from "vitest";

const invalidUrlPattern = /Invalid URL/u;

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

  it("scrubs scheme-less query and fragment tokens", async () => {
    // Given
    const { emitter, events } = createRecorder();
    const observed = createProviderObservationFetch(emitter, () =>
      Promise.reject(
        new Error(
          "Failed to parse gateway.example/v1?secret-token and host/path#secret"
        )
      )
    );

    // When / Then
    await expect(observed("gateway.example/v1?secret-token")).rejects.toThrow();
    const errorEvent = events.find((event) => event.type === "provider:error");
    const message = JSON.stringify(errorEvent?.payload ?? "");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("#secret");
  });

  it("scrubs URL-like tokens from transport error messages", async () => {
    // Given
    const { emitter, events } = createRecorder();
    const observed = createProviderObservationFetch(emitter, () =>
      Promise.reject(
        new Error(
          `Invalid URL: https://user:secret@gateway.example/v1?api-key=leak (${"x".repeat(400)})`
        )
      )
    );

    // When / Then
    await expect(observed("https://gateway.example/v1/chat")).rejects.toThrow(
      invalidUrlPattern
    );
    const errorEvent = events.find((event) => event.type === "provider:error");
    const message =
      errorEvent !== undefined &&
      typeof errorEvent.payload === "object" &&
      errorEvent.payload !== null &&
      "message" in errorEvent.payload
        ? String(errorEvent.payload.message)
        : "";
    expect(message).toContain("<redacted-url>");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("api-key=leak");
    expect(message.length).toBeLessThanOrEqual(256);
  });

  it("keeps a request bound to the sink captured at its start", async () => {
    // Given
    const first: RecordedEvent[] = [];
    const second: RecordedEvent[] = [];
    const emitter: ProviderObservationEmitter = {
      current: (type, payload) => {
        first.push({ payload, type });
      },
    };
    let releaseResponse: (() => void) | undefined;
    const observed = createProviderObservationFetch(
      emitter,
      () =>
        new Promise((resolveFetch) => {
          releaseResponse = () => resolveFetch(new Response("ok"));
        })
    );

    // When — a reload rebinds the emitter while the request is in flight.
    const pending = observed("https://gateway.example/v1/chat");
    emitter.current = (type, payload) => {
      second.push({ payload, type });
    };
    releaseResponse?.();
    await pending;

    // Then — both events landed on the original sink.
    expect(first.map((event) => event.type)).toEqual([
      "provider:request",
      "provider:response",
    ]);
    expect(second).toEqual([]);
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
