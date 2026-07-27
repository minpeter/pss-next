import { describe, expect, it } from "vitest";
import { createCallbackModel } from "../../testing/test-fixtures";
import { createRuntimeInputState } from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import { createAgentThreadContext } from "./agent-thread-context";
import { killAgentThread } from "./agent-thread-kill";
import { SpyStore } from "./test-support";

function createContext() {
  return createAgentThreadContext(
    { model: createCallbackModel(() => Promise.resolve([])) },
    { key: "kill-test", store: new SpyStore() },
    {}
  );
}

describe("killAgentThread", () => {
  it("transitions to killed before tearing the active turn down", () => {
    const context = createContext();
    const abort = new AbortController();
    context.turn.to({
      tag: "active",
      abort,
      run: new BufferedAgentTurn("run-1"),
      runtimeInput: createRuntimeInputState([]),
      turnId: "turn-1",
    });

    // Aborting the turn runs synchronous abort listeners; a re-entrant
    // kill() from one of them must observe the thread as already killed
    // instead of executing the teardown twice.
    let observedTag: string | undefined;
    let reentrantKill: Promise<void> | undefined;
    abort.signal.addEventListener(
      "abort",
      () => {
        observedTag = context.terminal.state.tag;
        reentrantKill = killAgentThread(context);
      },
      { once: true }
    );

    const killPromise = killAgentThread(context);

    expect(observedTag).toBe("killed");
    expect(reentrantKill).toBe(killPromise);
  });

  it("returns the same promise for repeated kills", async () => {
    const context = createContext();
    const first = killAgentThread(context);
    const second = killAgentThread(context);
    expect(second).toBe(first);
    await first;
    expect(context.terminal.state.tag).toBe("killed");
  });
});
