import { describe, expect, it } from "vitest";
import { userText } from "../../testing/test-fixtures";
import { createRuntimeInputState } from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import { drainRuntimeInput } from "./drain";
import {
  createDispatcher,
  createReplacedExecution,
  readEventTypes,
} from "./nonterminal-ownership-test-support";
import { createDurableThreadEventRecorder } from "./thread-event-log";

const CONFLICT_PATTERN = /conflict/i;

describe("nonterminal runtime-input drain ownership", () => {
  it("rejects runtime input after ownership replacement", async () => {
    // Given
    const { execution, host, state, threadKey } =
      await createReplacedExecution("runtime-input");
    const { buffer, record } = createDurableThreadEventRecorder();

    // When
    const draining = drainRuntimeInput({
      attachmentStore: host.attachmentStore,
      durableEvents: buffer,
      events: createDispatcher(host, state, threadKey),
      executionHost: host,
      executionRun: execution,
      placement: "turn-start",
      recordEvent: record,
      run: new BufferedAgentTurn(),
      runtimeInput: createRuntimeInputState([
        { input: userText("runtime"), placement: "turn-start" },
      ]),
      state,
      threadKey,
    });

    // Then
    await expect(draining).rejects.toThrow(CONFLICT_PATTERN);
    await expect(host.store.threads.load(threadKey)).resolves.toBeNull();
    await expect(readEventTypes(host, threadKey)).resolves.toEqual([]);
  });

  it("rejects durable runtime input and acknowledgement after replacement", async () => {
    // Given
    const { execution, host, state, threadKey } = await createReplacedExecution(
      "durable-runtime-input"
    );
    await host.store.inputs.admit({
      input: userText("durable runtime"),
      kind: "steer",
      messageId: "durable-runtime-message",
      placement: "turn-start",
      threadKey,
    });
    const { buffer, record } = createDurableThreadEventRecorder();

    // When
    const draining = drainRuntimeInput({
      attachmentStore: host.attachmentStore,
      durableEvents: buffer,
      events: createDispatcher(host, state, threadKey),
      executionHost: host,
      executionRun: execution,
      placement: "turn-start",
      recordEvent: record,
      run: new BufferedAgentTurn(),
      runtimeInput: createRuntimeInputState([]),
      state,
      threadKey,
    });

    // Then
    await expect(draining).rejects.toThrow(CONFLICT_PATTERN);
    await expect(host.store.threads.load(threadKey)).resolves.toBeNull();
    await expect(readEventTypes(host, threadKey)).resolves.toEqual([]);
    const claim = await host.store.inputs.claimNext(threadKey, "turn-start");
    expect(claim?.messageId).toBe("durable-runtime-message");
  });
});
