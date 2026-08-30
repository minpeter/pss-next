import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
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
  it("keeps the thread killed when replacement ownership fences cancellation", async () => {
    // Given: owner B replaces the active turn's captured owner A lease.
    const host = createInMemoryHost();
    const runId = "kill-replacement-owner";
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "kill-replacement",
    });
    const ownerA = await host.store.turns.claim(runId, {
      attempt: 1,
      leaseId: "owner-a",
      leaseMs: 100,
      nowMs: 10,
    });
    if (!ownerA.ok) {
      throw new TypeError("Expected owner A to claim the run.");
    }
    const ownerB = await host.store.turns.claim(runId, {
      attempt: 2,
      leaseId: "owner-b",
      leaseMs: 100,
      nowMs: 200,
    });
    if (!ownerB.ok) {
      throw new TypeError("Expected owner B to replace owner A.");
    }
    const context = createAgentThreadContext(
      { model: createCallbackModel(() => Promise.resolve([])) },
      { key: "kill-replacement", store: host.store.threads },
      { executionHost: host }
    );
    const run = new BufferedAgentTurn();
    run.bindRunId(runId, "owner-a");
    context.turn.to({
      abort: new AbortController(),
      run,
      runtimeInput: createRuntimeInputState([]),
      tag: "active",
      turnId: "turn-1",
    });

    // When: stale owner A tears down its local thread.
    const killed = killAgentThread(context);

    // Then: local teardown succeeds without touching owner B's run.
    await expect(killed).resolves.toBeUndefined();
    expect(context.terminal.state.tag).toBe("killed");
    await expect(host.store.turns.get(runId)).resolves.toEqual(ownerB.record);
  });

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
