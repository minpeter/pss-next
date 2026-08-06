import { describe, expect, it } from "vitest";
import type { AgentHost } from "../../execution";
import { createInMemoryHost } from "../../platform/memory";
import { userText } from "../../testing/test-fixtures";
import {
  createRuntimeInputState,
  type QueuedInput,
} from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import { cancelQueuedDurableThreadInputs } from "./durable-input-cancellation";
import {
  isLiveThreadInputOwnedByOther,
  liveThreadInputOwnedByOther,
  registerLiveThreadInput,
} from "./live-input-ownership";

describe("live durable input ownership", () => {
  it("releases waiters when a message owner is replaced", async () => {
    const host = createInMemoryHost();
    const first = {};
    const second = {};
    registerLiveThreadInput(host, "replace", "message", first);
    const released = liveThreadInputOwnedByOther(
      host,
      "replace",
      "message",
      second
    );
    registerLiveThreadInput(host, "replace", "message", second);
    await expect(released).resolves.toBeUndefined();
    expect(
      isLiveThreadInputOwnedByOther(host, "replace", "message", first)
    ).toBe(true);
  });

  it("releases ownership when durable kill cancellation fails", async () => {
    const base = createInMemoryHost();
    let failTransaction = true;
    const store = new Proxy(base.store, {
      get(target, property) {
        if (property === "transaction" && failTransaction) {
          failTransaction = false;
          return (): Promise<never> =>
            Promise.reject(new Error("transaction failed"));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const host: AgentHost = { ...base, store };
    const owner = {};
    const other = {};
    const messageId = crypto.randomUUID();
    await base.store.inputs.admit({
      input: userText("queued"),
      kind: "send",
      messageId,
      threadKey: "kill-failure",
    });
    registerLiveThreadInput(host, "kill-failure", messageId, owner);
    const item: QueuedInput = {
      acceptedEvent: userText("queued"),
      awaitBoundaries: false,
      durableInput: true,
      durableMessageId: messageId,
      durableOwner: owner,
      initialEvents: [],
      preUserRuntimeInputs: [],
      run: new BufferedAgentTurn(),
      runtimeInput: createRuntimeInputState([]),
    };

    await expect(
      cancelQueuedDurableThreadInputs({
        executionHost: host,
        items: [item],
        threadKey: "kill-failure",
      })
    ).rejects.toThrow("transaction failed");
    expect(
      isLiveThreadInputOwnedByOther(host, "kill-failure", messageId, other)
    ).toBe(true);

    await cancelQueuedDurableThreadInputs({
      executionHost: host,
      items: [item],
      threadKey: "kill-failure",
    });
    expect(
      isLiveThreadInputOwnedByOther(host, "kill-failure", messageId, other)
    ).toBe(false);
  });

  it("retains ownership while another claimant holds the durable record", async () => {
    const host = createInMemoryHost();
    const owner = {};
    const other = {};
    const messageId = crypto.randomUUID();
    await host.store.inputs.admit({
      input: userText("queued"),
      kind: "send",
      messageId,
      threadKey: "claim-race",
    });
    registerLiveThreadInput(host, "claim-race", messageId, owner);
    const held = await host.store.inputs.claimNext("claim-race", "turn-idle", {
      messageId,
    });
    expect(held).not.toBeNull();
    const item: QueuedInput = {
      acceptedEvent: userText("queued"),
      awaitBoundaries: false,
      durableInput: true,
      durableMessageId: messageId,
      durableOwner: owner,
      initialEvents: [],
      preUserRuntimeInputs: [],
      run: new BufferedAgentTurn(),
      runtimeInput: createRuntimeInputState([]),
    };

    await expect(
      cancelQueuedDurableThreadInputs({
        executionHost: host,
        items: [item],
        threadKey: "claim-race",
      })
    ).rejects.toThrow("Could not claim queued input");
    expect(
      isLiveThreadInputOwnedByOther(host, "claim-race", messageId, other)
    ).toBe(true);

    if (!held) {
      throw new Error("expected held claim");
    }
    await host.store.inputs.releaseClaim(held);
    await cancelQueuedDurableThreadInputs({
      executionHost: host,
      items: [item],
      threadKey: "claim-race",
    });
    expect(
      isLiveThreadInputOwnedByOther(host, "claim-race", messageId, other)
    ).toBe(false);
  });
});
