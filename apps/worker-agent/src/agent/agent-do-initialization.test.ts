import type { Agent } from "@minpeter/pss-runtime";
import { InMemoryDurableObjectStorage } from "@minpeter/pss-runtime/platform/durable-object";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import type { TurnSession } from "./agent-do-turn-session";

const mocks = vi.hoisted(() => ({
  createConfiguredAgent: vi.fn(),
  createTurnSession: vi.fn(),
}));

vi.mock("./agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent")>();
  return { ...actual, createConfiguredAgent: mocks.createConfiguredAgent };
});

vi.mock("./agent-do-turn-session", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./agent-do-turn-session")>();
  return { ...actual, createTurnSession: mocks.createTurnSession };
});

const { AgentDurableObject } = await import("./agent-do");

describe("AgentDurableObject agent initialization", () => {
  beforeEach(() => {
    mocks.createConfiguredAgent.mockReset();
    mocks.createTurnSession.mockReset();
    mocks.createTurnSession.mockReturnValue(successfulSession());
  });

  it("shares one initialization across concurrent turn requests", async () => {
    let finishInitialization: ((agent: Agent) => void) | undefined;
    mocks.createConfiguredAgent.mockImplementation(
      () =>
        new Promise<Agent>((resolve) => {
          finishInitialization = resolve;
        })
    );
    const object = createDurableObject();

    const first = object.fetch(turnRequest("first"));
    const second = object.fetch(turnRequest("second"));
    await vi.waitFor(() => {
      expect(mocks.createConfiguredAgent).toHaveBeenCalledTimes(1);
    });
    finishInitialization?.(fakeAgent());

    await expect(Promise.all([first, second])).resolves.toSatisfy(
      (responses: Response[]) => responses.every((response) => response.ok)
    );
    expect(mocks.createConfiguredAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createTurnSession).toHaveBeenCalledTimes(1);
  });

  it("allows initialization to retry after a failure", async () => {
    mocks.createConfiguredAgent
      .mockRejectedValueOnce(new Error("initialization failed"))
      .mockResolvedValueOnce(fakeAgent());
    const object = createDurableObject();

    await expect(object.fetch(turnRequest("first"))).rejects.toThrow(
      "initialization failed"
    );
    await expect(object.fetch(turnRequest("second"))).resolves.toMatchObject({
      ok: true,
    });

    expect(mocks.createConfiguredAgent).toHaveBeenCalledTimes(2);
    expect(mocks.createTurnSession).toHaveBeenCalledTimes(1);
  });
});

function successfulSession(): TurnSession {
  return {
    deliver: () => Promise.resolve({ delivered: true, mode: "send" }),
    isActive: () => false,
  };
}

function fakeAgent(): Agent {
  return {
    dispose: () => Promise.resolve(),
    thread: () => ({}),
  } as unknown as Agent;
}

function createDurableObject(): InstanceType<typeof AgentDurableObject> {
  const storage = new InMemoryDurableObjectStorage();
  const state = { storage } as unknown as DurableObjectState;
  const env = {
    AGENT_DO: {
      get: () => ({ fetch: () => Promise.resolve(Response.json({})) }),
      idFromName: (name: string) => name,
    },
    AI_API_KEY: "test-key",
    ENVIRONMENT: "development",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
  } as unknown as Env;
  return new AgentDurableObject(state, env);
}

function turnRequest(text: string): Request {
  return new Request("https://agent.internal/turn", {
    body: JSON.stringify({ channel: { id: "chat", kind: "tui" }, text }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}
