import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodingAgentRpcSession } from "./rpc";

function turn(events: readonly AgentEvent[]): AgentTurn {
  return {
    async *events() {
      await Promise.resolve();
      for (const event of events) {
        yield event;
      }
    },
  } as AgentTurn;
}

describe("coding-agent RPC session", () => {
  it("accepts a prompt, emits correlated events, and returns to idle", async () => {
    const send = vi.fn(() =>
      Promise.resolve(turn([{ type: "turn-end" } as AgentEvent]))
    );
    const session = createCodingAgentRpcSession({
      interrupt: vi.fn(),
      send,
      steer: vi.fn(),
    });
    const emitted: unknown[] = [];
    await expect(
      Promise.resolve(
        session.handler.handle(
          "prompt",
          { prompt: "hello" },
          {
            emit: (event, requestId) => emitted.push({ event, requestId }),
            requestId: 7,
          }
        )
      )
    ).resolves.toEqual({ accepted: true });
    await session.settled;
    expect(send).toHaveBeenCalledWith("hello");
    expect(emitted).toEqual([
      { event: { type: "turn-end" }, requestId: undefined },
    ]);
    expect(
      session.handler.handle("state", {}, { emit: vi.fn(), requestId: 8 })
    ).toEqual({ activeRequestId: null, status: "idle" });
  });

  it("validates prompts and exposes steer and abort", async () => {
    const interrupt = vi.fn();
    const steer = vi.fn(() => Promise.resolve(turn([])));
    const session = createCodingAgentRpcSession({
      interrupt,
      send: vi.fn(),
      steer,
    });
    const context = { emit: vi.fn(), requestId: 1 };
    await expect(
      Promise.resolve().then(() =>
        session.handler.handle("prompt", {}, context)
      )
    ).rejects.toMatchObject({ code: -32_602 });
    await expect(
      Promise.resolve().then(() =>
        session.handler.handle("steer", { prompt: "adjust" }, context)
      )
    ).rejects.toMatchObject({ code: -32_003 });
    expect(steer).not.toHaveBeenCalled();
    expect(session.handler.handle("abort", {}, context)).toEqual({
      interrupted: false,
    });
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("steers only a tracked active prompt", async () => {
    let resolveTurn: ((turn: AgentTurn) => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<AgentTurn>((resolve) => {
          resolveTurn = resolve;
        })
    );
    const steer = vi.fn(() => Promise.resolve(turn([])));
    const session = createCodingAgentRpcSession({
      interrupt: vi.fn(),
      send,
      steer,
    });
    const context = { emit: vi.fn(), requestId: 9 };
    expect(
      session.handler.handle("prompt", { prompt: "start" }, context)
    ).toEqual({ accepted: true });
    await expect(
      session.handler.handle("steer", { prompt: "adjust" }, context)
    ).resolves.toEqual({ accepted: true });
    expect(steer).toHaveBeenCalledWith("adjust");
    resolveTurn?.(turn([]));
    await session.settled;
  });
});
