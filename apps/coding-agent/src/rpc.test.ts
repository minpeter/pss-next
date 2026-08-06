import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { servePssProtocol } from "@minpeter/pss-runtime/protocol";
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
      Promise.resolve().then(() =>
        session.handler.handle("steer", { prompt: "too early" }, context)
      )
    ).rejects.toMatchObject({ code: -32_004 });
    expect(steer).not.toHaveBeenCalled();

    let finishEvents: (() => void) | undefined;
    const activeTurn = {
      async *events() {
        await new Promise<void>((resolve) => {
          finishEvents = resolve;
        });
      },
    } as AgentTurn;
    resolveTurn?.(activeTurn);
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      session.handler.handle("steer", { prompt: "adjust" }, context)
    ).resolves.toEqual({ accepted: true });
    expect(steer).toHaveBeenCalledWith("adjust");
    finishEvents?.();
    await session.settled;
  });

  it("rejects adjacent steer frames while runtime send admission is pending", async () => {
    const steer = vi.fn(() => Promise.resolve(turn([])));
    let resolveTurn: ((turn: AgentTurn) => void) | undefined;
    const session = createCodingAgentRpcSession({
      interrupt: vi.fn(),
      send: vi.fn(
        () =>
          new Promise<AgentTurn>((resolve) => {
            resolveTurn = resolve;
          })
      ),
      steer,
    });
    const input = [
      '{"id":1,"jsonrpc":"2.0","method":"prompt","params":{"prompt":"start"},"protocol":"pss/1"}',
      '{"id":2,"jsonrpc":"2.0","method":"steer","params":{"prompt":"early"},"protocol":"pss/1"}',
    ].join("\n");
    const output: string[] = [];
    setTimeout(() => resolveTurn?.(turn([])), 0);
    await servePssProtocol(
      {
        readable: (async function* () {
          await Promise.resolve();
          yield `${input}\n`;
        })(),
        write: (frame) => {
          output.push(frame);
        },
      },
      session.handler
    );
    const responses = output.map((frame) => JSON.parse(frame));
    expect(responses).toContainEqual(
      expect.objectContaining({ id: 1, result: { accepted: true } })
    );
    expect(responses).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32_004 }),
        id: 2,
      })
    );
    expect(steer).not.toHaveBeenCalled();
  });

  it("latches abort while send admission is pending", async () => {
    let resolveTurn: ((turn: AgentTurn) => void) | undefined;
    const interrupt = vi.fn();
    const session = createCodingAgentRpcSession({
      interrupt,
      send: vi.fn(
        () =>
          new Promise<AgentTurn>((resolve) => {
            resolveTurn = resolve;
          })
      ),
      steer: vi.fn(),
    });
    const context = { emit: vi.fn(), requestId: 11 };
    session.handler.handle("prompt", { prompt: "start" }, context);
    expect(session.handler.handle("abort", {}, context)).toEqual({
      interrupted: true,
    });
    expect(interrupt).toHaveBeenCalledOnce();
    resolveTurn?.(turn([]));
    await session.settled;
    expect(interrupt).toHaveBeenCalledTimes(2);
  });
});
