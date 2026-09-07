import type { AgentTurn } from "@minpeter/pss-runtime";
import { InvalidStateTransitionError } from "@minpeter/pss-runtime/fsm";
import { describe, expect, it, vi } from "vitest";
import { TuiSessionMachine } from "./session-state";

const fakeRun = (): AgentTurn => ({}) as AgentTurn;

describe("TuiSessionMachine prompt", () => {
  it("walks idle -> awaiting -> processing -> awaiting", () => {
    const session = new TuiSessionMachine();
    expect(session.promptState.tag).toBe("idle");

    const resolve = vi.fn();
    session.awaitInput(resolve);
    expect(session.promptState.tag).toBe("awaiting");

    expect(session.submitInput("hello")).toBe(true);
    expect(resolve).toHaveBeenCalledWith("hello");
    expect(session.promptState.tag).toBe("processing");

    session.awaitInput(vi.fn());
    expect(session.promptState.tag).toBe("awaiting");
  });

  it("ignores submits while no waiter is registered", () => {
    const session = new TuiSessionMachine();
    expect(session.submitInput("ignored")).toBe(false);

    session.awaitInput(vi.fn());
    session.submitInput("consumed");
    expect(session.submitInput("ignored again")).toBe(false);
  });

  it("rejects double awaitInput", () => {
    const session = new TuiSessionMachine();
    session.awaitInput(vi.fn());
    expect(() => session.awaitInput(vi.fn())).toThrow(
      InvalidStateTransitionError
    );
  });

  it("close resolves the pending waiter with null and is idempotent", () => {
    const session = new TuiSessionMachine();
    const resolve = vi.fn();
    session.awaitInput(resolve);

    session.close();
    expect(resolve).toHaveBeenCalledWith(null);
    expect(session.closed).toBe(true);

    session.close();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("resolves null immediately when awaiting input after close", () => {
    const session = new TuiSessionMachine();
    session.close();

    const resolve = vi.fn();
    session.awaitInput(resolve);
    expect(resolve).toHaveBeenCalledWith(null);
    expect(session.promptState.tag).toBe("closed");
  });

  it("ignores submits after close", () => {
    const session = new TuiSessionMachine();
    session.close();
    expect(session.submitInput("late")).toBe(false);
  });
});

describe("TuiSessionMachine turn", () => {
  it("tracks the active run and interruption", () => {
    const session = new TuiSessionMachine();
    const run = fakeRun();
    expect(session.activeTurn).toBeUndefined();
    expect(session.markInterrupted()).toBeUndefined();

    session.beginTurn(run);
    expect(session.activeTurn?.run).toBe(run);
    expect(session.wasInterrupted(run)).toBe(false);

    expect(session.markInterrupted()).toBe(run);
    expect(session.wasInterrupted(run)).toBe(true);

    session.endTurn(run);
    expect(session.activeTurn).toBeUndefined();
    expect(session.wasInterrupted(run)).toBe(false);
  });

  it("does not let a finished predecessor clear a steering replacement run", () => {
    const session = new TuiSessionMachine();
    const first = fakeRun();
    const replacement = fakeRun();

    session.beginTurn(first);
    // Steering started a fresh turn while the first one still winds down.
    session.beginTurn(replacement);

    session.endTurn(first);
    expect(session.activeTurn?.run).toBe(replacement);

    session.endTurn(replacement);
    expect(session.activeTurn).toBeUndefined();
  });

  it("restores a still-running predecessor when a distinct steering run finishes first", () => {
    const session = new TuiSessionMachine();
    const original = fakeRun();
    const steering = fakeRun();
    session.beginTurn(original);
    session.beginTurn(steering);
    session.endTurn(steering);
    expect(session.activeTurn?.run).toBe(original);
    expect(session.markInterrupted()).toBe(original);
    expect(session.wasInterrupted(original)).toBe(true);
    session.endTurn(original);
    expect(session.activeTurn).toBeUndefined();
  });

  it("resets the interrupted flag when a replacement run begins", () => {
    const session = new TuiSessionMachine();
    const first = fakeRun();
    session.beginTurn(first);
    session.markInterrupted();

    const replacement = fakeRun();
    session.beginTurn(replacement);
    expect(session.wasInterrupted(replacement)).toBe(false);
  });

  it("keeps turn state independent from prompt state", () => {
    const session = new TuiSessionMachine();
    const run = fakeRun();
    session.beginTurn(run);

    // The editor may wait for input while a turn streams (steering).
    session.awaitInput(vi.fn());
    expect(session.activeTurn?.run).toBe(run);

    session.close();
    expect(session.activeTurn?.run).toBe(run);
  });
});
