import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./events";
import { BufferedAgentTurn, bindTurnExecutionRun } from "./turn";

const expectPending = async (promise: Promise<unknown>) => {
  const marker = Symbol("pending");
  await expect(Promise.race([promise, Promise.resolve(marker)])).resolves.toBe(
    marker
  );
};

const falsyErrors: readonly unknown[] = [
  false,
  0,
  -0,
  0n,
  "",
  null,
  undefined,
  Number.NaN,
];

const expectRejectedWith = async (
  promise: Promise<unknown>,
  expected: unknown
) => {
  const result = await promise.then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ error, status: "rejected" as const })
  );

  expect(result.status).toBe("rejected");
  if (result.status === "rejected") {
    expect(Object.is(result.error, expected)).toBe(true);
  }
};

describe("AgentTurn", () => {
  it("binds one stable optional durable run id", () => {
    const local = new BufferedAgentTurn();
    expect(local.runId).toBeUndefined();

    bindTurnExecutionRun(local, "run-1");
    bindTurnExecutionRun(local, "run-1");

    expect(local.runId).toBe("run-1");
    expect(() => bindTurnExecutionRun(local, "run-2")).toThrow(
      "AgentTurn is already bound to run id run-1"
    );
  });

  it("delivers events emitted before events consumption", async () => {
    const run = new BufferedAgentTurn();
    run.emit({ type: "user-input", text: "hello" });
    run.emit({ type: "turn-end" });
    run.close();

    const events: AgentEvent[] = [];
    for await (const event of run.events()) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "user-input", text: "hello" },
      { type: "turn-end" },
    ]);
  });

  it("delivers events emitted after events consumption starts", async () => {
    const run = new BufferedAgentTurn();
    const events: unknown[] = [];
    const collecting = (async () => {
      for await (const event of run.events()) {
        events.push(event);
      }
    })();

    run.emit({ type: "turn-start" });
    run.emit({ type: "turn-end" });
    run.close();
    await collecting;

    expect(events).toEqual([{ type: "turn-start" }, { type: "turn-end" }]);
  });

  it("keeps boundary emit pending until the consumer asks for another event", async () => {
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();

    const boundary = run.emitBoundary({ type: "step-end" });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "step-end" },
    });
    await expectPending(boundary);

    const nextEvent = iterator.next();
    await boundary;
    run.emit({ type: "turn-end" });

    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: { type: "turn-end" },
    });
  });

  it("rejects duplicate events readers", () => {
    const run = new BufferedAgentTurn();
    run.events();
    expect(() => run.events()).toThrow(
      "AgentTurn.events() can only be consumed once"
    );
  });

  it("returns the same iterator for repeated async iterator access", () => {
    const run = new BufferedAgentTurn();
    const eventIterator = run.events();

    expect(eventIterator[Symbol.asyncIterator]()).toBe(
      eventIterator[Symbol.asyncIterator]()
    );
  });

  it("rejects concurrent next calls so consumers cannot prefetch", async () => {
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();

    const waitingNext = iterator.next();
    await expect(iterator.next()).rejects.toThrow(
      "AgentTurn.events() does not allow concurrent next() calls"
    );

    run.emit({ type: "turn-start" });
    await expect(waitingNext).resolves.toEqual({
      done: false,
      value: { type: "turn-start" },
    });
  });

  it("rejects same-tick prefetch when a boundary event is already queued", async () => {
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();

    const boundary = run.emitBoundary({ type: "step-end" });
    const first = iterator.next();
    const second = iterator.next();

    await expect(second).rejects.toThrow(
      "AgentTurn.events() does not allow concurrent next() calls"
    );
    await expectPending(boundary);
    await expect(first).resolves.toEqual({
      done: false,
      value: { type: "step-end" },
    });
    await expectPending(boundary);

    const afterHandling = iterator.next();
    await boundary;
    run.emit({ type: "turn-end" });

    await expect(afterHandling).resolves.toEqual({
      done: false,
      value: { type: "turn-end" },
    });
  });

  it("return() settles pending boundary ack and pending next waiter", async () => {
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();

    const boundary = run.emitBoundary({ type: "step-start" });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "step-start" },
    });
    const waitingNext = iterator.next();

    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(boundary).resolves.toBeUndefined();
    await expect(waitingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("close() completes a pending next request successfully", async () => {
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();
    const next = iterator.next();

    run.close();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
  });

  it("preserves the first successful or failed closure outcome", async () => {
    const successfulRun = new BufferedAgentTurn();
    successfulRun.close();
    successfulRun.closeWithError(new Error("late failure"));
    const successfulIterator = successfulRun.events()[Symbol.asyncIterator]();
    await expect(successfulIterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    const failure = new Error("first failure");
    const failedRun = new BufferedAgentTurn();
    failedRun.closeWithError(failure);
    failedRun.close();
    const failedIterator = failedRun.events()[Symbol.asyncIterator]();
    await expectRejectedWith(failedIterator.next(), failure);
  });

  it.each(falsyErrors)(
    "closeWithError rejects a future next request with falsy error %#",
    async (error) => {
      const run = new BufferedAgentTurn();
      run.closeWithError(error);
      run.emit({ type: "turn-start" });
      const iterator = run.events()[Symbol.asyncIterator]();

      await expectRejectedWith(iterator.next(), error);
    }
  );

  it.each(falsyErrors)(
    "closeWithError rejects a pending next request with falsy error %#",
    async (error) => {
      const run = new BufferedAgentTurn();
      const iterator = run.events()[Symbol.asyncIterator]();
      const next = iterator.next();

      run.closeWithError(error);

      await expectRejectedWith(next, error);
    }
  );

  it("close() settles queued boundary acknowledgements", async () => {
    const run = new BufferedAgentTurn();
    const boundary = run.emitBoundary({ type: "step-start" });
    await expectPending(boundary);

    run.close();

    await expect(boundary).resolves.toBeUndefined();
  });

  it("closes and discards queued events when the events iterator returns early", async () => {
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();

    run.emit({ type: "turn-start" });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn-start" },
    });

    run.emit({ type: "step-start" });
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    run.emit({ type: "turn-end" });

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
