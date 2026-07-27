import type { AgentTurn } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import { dispatchUserInput } from "./input-routing";

const createRun = (): AgentTurn => ({
  async *events() {
    // No events are needed to test routing.
  },
});

const hooks = {
  clearStatus: vi.fn(),
  showStatus: vi.fn(),
};

describe("dispatchUserInput", () => {
  it("does not forward input rejected by preprocessing", async () => {
    const run = createRun();
    const thread = {
      send: vi.fn(async (_input: string) => run),
      steer: vi.fn(async (_input: string) => run),
    };

    const result = await dispatchUserInput({
      hooks,
      input: "blocked",
      preprocess: async () => ({ error: "rejected", success: false }),
      thread,
    });

    expect(result).toEqual({ error: "rejected", type: "rejected" });
    expect(thread.send).not.toHaveBeenCalled();
    expect(thread.steer).not.toHaveBeenCalled();
  });

  it("steers an active run without sending a separate turn", async () => {
    const run = createRun();
    const thread = {
      send: vi.fn(async (_input: string) => run),
      steer: vi.fn(async (_input: string) => run),
    };

    const result = await dispatchUserInput({
      activeRun: run,
      hooks,
      input: " extra ",
      thread,
    });

    expect(thread.send).not.toHaveBeenCalled();
    expect(thread.steer).toHaveBeenCalledWith(" extra ");
    expect(result).toMatchObject({
      consumeRun: false,
      run,
      type: "steered",
    });
  });
});
