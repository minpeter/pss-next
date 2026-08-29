import { createTRPCClient, httpLink } from "@trpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { channelKey } from "../channel";
import { durableObjectName, type Env } from "../env";
import {
  handleWorkerRpcRequest,
  type WorkerAgentRouter,
} from "../rpc/worker-rpc";

const durableObjectMock = vi.hoisted(
  (): {
    readonly requests: {
      readonly objectName: string;
      readonly request: Request;
    }[];
    readonly responses: Response[];
  } => ({
    requests: [],
    responses: [],
  })
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
      durableObjectMock.responses.shift() ??
        Response.json({
          delivered: true,
          messages: [],
        })
    );
  },
}));

describe("TUI worker tRPC route", () => {
  beforeEach(() => {
    durableObjectMock.requests.length = 0;
    durableObjectMock.responses.length = 0;
  });

  it("forwards development TUI turns to the channel Durable Object", async () => {
    const env = createEnv({ ENVIRONMENT: "development" });
    durableObjectMock.responses.push(
      Response.json({
        delivered: true,
        messages: [
          {
            channel: "tui:local",
            messageId: "tui-1",
            text: "visible",
          },
        ],
      })
    );

    const client = createTuiRpcTestClient(env);

    await expect(
      client.tui.turn.mutate({
        channel: { id: " local ", kind: "tui" },
        text: " hello ",
      })
    ).resolves.toEqual({
      delivered: true,
      messages: [
        {
          channel: "tui:local",
          messageId: "tui-1",
          text: "visible",
        },
      ],
    });

    const [request] = durableObjectMock.requests;
    if (!request) {
      throw new Error("Expected a Durable Object request.");
    }
    expect(request.objectName).toBe(
      durableObjectName(channelKey({ id: "local", kind: "tui" }))
    );
    await expect(request.request.json()).resolves.toEqual({
      channel: { id: "local", kind: "tui" },
      text: "hello",
    });
  });

  it("forwards an explicit TUI session scope to the channel Durable Object", async () => {
    const env = createEnv({ ENVIRONMENT: "development" });
    const client = createTuiRpcTestClient(env);

    await expect(
      client.tui.turn.mutate({
        channel: { id: "local", kind: "tui" },
        sessionScopeKey: " tui:local-user ",
        text: "hello",
      })
    ).resolves.toMatchObject({ delivered: true });

    const [request] = durableObjectMock.requests;
    if (!request) {
      throw new Error("Expected a Durable Object request.");
    }
    await expect(request.request.json()).resolves.toEqual({
      channel: { id: "local", kind: "tui" },
      sessionScopeKey: "tui:local-user",
      text: "hello",
    });
  });

  it("returns a durable admission receipt from session.submitTurn", async () => {
    const env = createEnv({ ENVIRONMENT: "development" });
    durableObjectMock.responses.push(
      Response.json({
        accepted: true,
        runId: "run-durable-1",
        threadKey: "default",
      })
    );
    const client = createTuiRpcTestClient(env);

    await expect(
      client.session.submitTurn.mutate({
        channel: { id: " local ", kind: "tui" },
        idempotencyKey: " turn-1 ",
        sessionScopeKey: " tui:user ",
        text: " hello ",
      })
    ).resolves.toEqual({
      accepted: true,
      runId: "run-durable-1",
      threadKey: "default",
    });

    const [request] = durableObjectMock.requests;
    if (!request) {
      throw new Error("Expected a Durable Object request.");
    }
    expect(new URL(request.request.url).pathname).toBe("/session/turn");
    await expect(request.request.json()).resolves.toEqual({
      channel: { id: "local", kind: "tui" },
      idempotencyKey: "turn-1",
      sessionScopeKey: "tui:user",
      text: "hello",
    });
  });

  it("replays durable session events after a cursor", async () => {
    const env = createEnv({ ENVIRONMENT: "development" });
    durableObjectMock.responses.push(
      Response.json({
        events: [
          {
            cursor: { offset: 3 },
            event: { type: "turn-end" },
            threadKey: "default",
          },
        ],
        nextCursor: { offset: 3 },
      })
    );
    const client = createTuiRpcTestClient(env);

    await expect(
      client.session.replayEvents.query({
        after: { offset: 2 },
        channel: { id: "local", kind: "tui" },
        limit: 25,
        sessionScopeKey: "tui:user",
      })
    ).resolves.toEqual({
      events: [
        {
          cursor: { offset: 3 },
          event: { type: "turn-end" },
          threadKey: "default",
        },
      ],
      nextCursor: { offset: 3 },
    });

    const [request] = durableObjectMock.requests;
    if (!request) {
      throw new Error("Expected a Durable Object request.");
    }
    expect(new URL(request.request.url).pathname).toBe(
      "/session/events/replay"
    );
    await expect(request.request.json()).resolves.toEqual({
      after: { offset: 2 },
      channel: { id: "local", kind: "tui" },
      limit: 25,
      sessionScopeKey: "tui:user",
    });
  });
});

function createTuiRpcTestClient(env: Env) {
  return createTRPCClient<WorkerAgentRouter>({
    links: [
      httpLink({
        fetch: (input, init) =>
          handleWorkerRpcRequest(new Request(input, init), env),
        url: "https://worker.example.com/trpc",
      }),
    ],
  });
}

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
