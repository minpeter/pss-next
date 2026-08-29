import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { handleWorkerRpcRequest } from "../rpc/worker-rpc";

const durableObjectMock = vi.hoisted(
  (): {
    readonly requests: {
      readonly objectName: string;
      readonly request: Request;
    }[];
  } => ({ requests: [] })
);

vi.mock("@minpeter/pss-runtime/platform/durable-object/cloudflare", () => ({
  fetchCloudflareDurableObject: (options: unknown) => {
    if (
      !(
        typeof options === "object" &&
        options !== null &&
        "objectName" in options &&
        typeof options.objectName === "string" &&
        "request" in options &&
        options.request instanceof Request
      )
    ) {
      throw new Error("Expected Durable Object fetch options.");
    }
    durableObjectMock.requests.push({
      objectName: options.objectName,
      request: options.request,
    });
    return Promise.resolve(
      Response.json({
        delivered: true,
        messages: [],
      })
    );
  },
}));

describe("TUI worker tRPC route authentication", () => {
  beforeEach(() => {
    durableObjectMock.requests.length = 0;
  });

  it("rejects production TUI turns without the configured token", async () => {
    const env = createEnv({
      ENVIRONMENT: "production",
      WORKER_AGENT_TUI_TOKEN: "secret",
    });

    const response = await handleWorkerRpcRequest(
      new Request("https://worker.example.com/trpc/tui.turn", {
        body: JSON.stringify({
          channel: { id: "local", kind: "tui" },
          text: "hello",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env
    );

    expect(response.status).toBe(401);
    expect(durableObjectMock.requests).toEqual([]);
  });

  it("accepts production TUI turns with the configured token", async () => {
    const env = createEnv({
      ENVIRONMENT: "production",
      WORKER_AGENT_TUI_TOKEN: "secret",
    });

    const response = await handleWorkerRpcRequest(
      new Request("https://worker.example.com/trpc/tui.turn", {
        body: JSON.stringify({
          channel: { id: "local", kind: "tui" },
          text: "hello",
        }),
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        method: "POST",
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(durableObjectMock.requests).toHaveLength(1);
  });

  it("rejects non-TUI channels", async () => {
    const env = createEnv({ ENVIRONMENT: "development" });

    const response = await handleWorkerRpcRequest(
      new Request("https://worker.example.com/trpc/tui.turn", {
        body: JSON.stringify({
          channel: { id: "chat-1", kind: "telegram" },
          text: "hello",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(durableObjectMock.requests).toEqual([]);
  });

  it("does not expose known-key inspect over tRPC", async () => {
    const response = await handleWorkerRpcRequest(
      new Request(
        'https://worker.example.com/trpc/tui.inspect?input={"conversationKey":"telegram:123"}',
        { method: "GET" }
      ),
      createEnv({ ENVIRONMENT: "development" })
    );

    expect(response.status).toBe(404);
    expect(durableObjectMock.requests).toEqual([]);
  });
});

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    AGENT_DO: createDurableObjectNamespace("agent"),
    AI_API_KEY: "test-key",
    ENVIRONMENT: "development",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
    ...overrides,
  };
}

function createDurableObjectNamespace(label: string): DurableObjectNamespace {
  const namespace: DurableObjectNamespace = {
    get(_id: DurableObjectId) {
      throw new Error(`${label} namespace should not be fetched`);
    },
    getByName(_name: string) {
      throw new Error(`${label} namespace should not be fetched`);
    },
    idFromString(id: string) {
      return createDurableObjectId(id);
    },
    idFromName(name: string) {
      return createDurableObjectId(name);
    },
    jurisdiction() {
      return namespace;
    },
    newUniqueId() {
      return createDurableObjectId(`${label}-unique`);
    },
  };
  return namespace;
}

function createDurableObjectId(name: string): DurableObjectId {
  return {
    equals(other: DurableObjectId) {
      return other.toString() === name;
    },
    name,
    toString() {
      return name;
    },
  };
}
