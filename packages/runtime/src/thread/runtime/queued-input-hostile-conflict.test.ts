import { describe, expect, it } from "vitest";
import type { AgentHost } from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  userText,
} from "../../testing/test-fixtures";
import { createRuntimeInputState } from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import { BufferedAgentTurn } from "../protocol/turn";
import { ThreadState } from "../state/thread-state";
import { createDispatcher } from "./nonterminal-ownership-test-support";
import { processQueuedInput } from "./queued-input-processor";

describe("queued input conflict detection", () => {
  it("recovers a hostile start rejection whose prototype lookup traps", async () => {
    // Given
    const base = createInMemoryHost();
    const hostileRejection = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("PROTOTYPE_SECRET");
        },
      }
    );
    const turns = new Proxy(base.store.turns, {
      get(target, property) {
        if (property === "create") {
          return () => Promise.reject(hostileRejection);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = new Proxy(base.store, {
      get(target, property) {
        if (property === "turns") {
          return turns;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const host: AgentHost = { ...base, store };
    const threadKey = "hostile-start-rejection";
    const state = new ThreadState({
      key: threadKey,
      store: host.store.threads,
    });
    const run = new BufferedAgentTurn();
    const collected = collectEvents(run);

    // When
    await processQueuedInput({
      activate: () => undefined,
      deactivateRun: () => undefined,
      events: createDispatcher(host, state, threadKey),
      execution: { executionHost: host },
      item: {
        initialEvents: [],
        input: userText("trigger rejection"),
        preUserRuntimeInputs: [],
        run,
        runtimeInput: createRuntimeInputState([]),
      },
      model: {
        attachmentStore: host.attachmentStore,
        model: createCallbackModel(() =>
          Promise.resolve([assistantMessage("not reached")])
        ),
      },
      release: () => undefined,
      state,
      threadKey,
    });
    const events = await collected;

    // Then
    expect(events).toContainEqual({
      error: { category: "unknown", version: 1 },
      message: "The request failed.",
      type: "turn-error",
    });
    expect(JSON.stringify(events)).not.toContain("PROTOTYPE_SECRET");
  });
});

async function collectEvents(run: BufferedAgentTurn): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}
