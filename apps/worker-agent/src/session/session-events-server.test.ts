import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { handleSessionEventsRequest } from "./session-events-server";

const durableObjectMock = vi.hoisted(
  (): {
    readonly requests: Request[];
  } => ({ requests: [] })
);

vi.mock("@minpeter/pss-runtime/platform/durable-object/cloudflare", () => ({
  fetchCloudflareDurableObject: (options: unknown) => {
    if (
      !(
        typeof options === "object" &&
        options !== null &&
        "request" in options &&
        options.request instanceof Request
      )
    ) {
      throw new Error("Expected Durable Object fetch options.");
    }
    durableObjectMock.requests.push(options.request);
    return Promise.resolve(
      new Response("event: ready\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    );
  },
}));

describe("session SSE worker route", () => {
  beforeEach(() => {
    durableObjectMock.requests.length = 0;
  });

  it("rejects a production stream without bearer auth", async () => {
    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal"),
      createEnv()
    );

    expect(response.status).toBe(401);
    expect(durableObjectMock.requests).toEqual([]);
  });

  it("proxies an authorized cursor stream to the channel Durable Object", async () => {
    const response = await handleSessionEventsRequest(
      new Request(
        "https://worker.example/session/events?channel=tui%3Alocal&after=4&sessionScopeKey=tui%3Auser",
        { headers: { authorization: "Bearer secret" } }
      ),
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(durableObjectMock.requests).toHaveLength(1);
    const internal = durableObjectMock.requests[0];
    if (!internal) {
      throw new Error("expected internal event stream request");
    }
    const url = new URL(internal.url);
    expect(url.pathname).toBe("/session/events");
    expect(url.searchParams.get("channel")).toBe("tui:local");
    expect(url.searchParams.get("after")).toBe("4");
    expect(url.searchParams.get("sessionScopeKey")).toBe("tui:user");
  });
});

function createEnv(): Env {
  return {
    AGENT_DO: {
      get: () => {
        throw new Error("namespace should be mocked");
      },
      getByName: () => {
        throw new Error("namespace should be mocked");
      },
      idFromName: (name: string) => ({ name, toString: () => name }),
    } as unknown as DurableObjectNamespace,
    AI_API_KEY: "test-key",
    ENVIRONMENT: "production",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
    WORKER_AGENT_TUI_TOKEN: "secret",
  };
}
