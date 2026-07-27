import { describe, expect, it } from "vitest";
import type { RuntimeInputState } from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import {
  assertThreadMachineInvariants,
  createThreadDrainMachine,
  createThreadLifecycleMachine,
  createThreadTerminalMachine,
  createThreadTurnMachine,
} from "./agent-thread-machines";

const TURN_OUTSIDE_DRAIN = /turn is "active" while drain is "idle"/;
const SHUTDOWN_WHILE_OPEN =
  /lifecycle is "stopping" while terminal is still "open"/;

function createMachines() {
  return {
    drain: createThreadDrainMachine(),
    lifecycle: createThreadLifecycleMachine(),
    terminal: createThreadTerminalMachine(),
    turn: createThreadTurnMachine(),
  };
}

function activateTurn(machines: ReturnType<typeof createMachines>): void {
  machines.turn.to({
    tag: "active",
    abort: new AbortController(),
    run: {} as BufferedAgentTurn,
    runtimeInput: {} as RuntimeInputState,
    turnId: "turn-1",
  });
}

describe("assertThreadMachineInvariants", () => {
  it("accepts freshly created machines", () => {
    expect(() => assertThreadMachineInvariants(createMachines())).not.toThrow();
  });

  it("accepts an active turn inside a running drain loop", () => {
    const machines = createMachines();
    machines.drain.to({
      tag: "draining",
      promise: Promise.resolve(),
      restartRequested: false,
    });
    activateTurn(machines);
    expect(() => assertThreadMachineInvariants(machines)).not.toThrow();
  });

  it("rejects a turn that exists outside a drain loop", () => {
    const machines = createMachines();
    machines.drain.to({
      tag: "draining",
      promise: Promise.resolve(),
      restartRequested: false,
    });
    activateTurn(machines);
    machines.drain.to({ tag: "idle" });
    expect(() => assertThreadMachineInvariants(machines)).toThrow(
      TURN_OUTSIDE_DRAIN
    );
  });

  it("rejects shutdown on a thread that was never killed", () => {
    const machines = createMachines();
    machines.lifecycle.to({ tag: "starting", promise: Promise.resolve() });
    machines.lifecycle.to({ tag: "stopping", promise: Promise.resolve() });
    expect(() => assertThreadMachineInvariants(machines)).toThrow(
      SHUTDOWN_WHILE_OPEN
    );
  });

  it("accepts shutdown after kill", () => {
    const machines = createMachines();
    machines.terminal.to({ tag: "killed", killPromise: Promise.resolve() });
    machines.lifecycle.to({ tag: "starting", promise: Promise.resolve() });
    machines.lifecycle.to({ tag: "stopping", promise: Promise.resolve() });
    expect(() => assertThreadMachineInvariants(machines)).not.toThrow();
  });
});
