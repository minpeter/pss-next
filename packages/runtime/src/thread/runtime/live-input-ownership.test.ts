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
  registerLiveThreadInput,
} from "./live-input-ownership";

describe("live durable input ownership", () => {
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
});
