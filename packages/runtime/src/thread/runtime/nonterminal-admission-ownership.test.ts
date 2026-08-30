import { describe, expect, it } from "vitest";
import { userText } from "../../testing/test-fixtures";
import { commitPreUserRuntimeInputs } from "../input/runtime-input-emit";
import { commitAndAckDurableThreadInput } from "./durable-input-acknowledgement";
import {
  createDispatcher,
  createReplacedExecution,
  readEventTypes,
} from "./nonterminal-ownership-test-support";
import {
  commitThreadStateAndEvents,
  createDurableThreadEventRecorder,
} from "./thread-event-log";

const CONFLICT_PATTERN = /conflict/i;

describe("nonterminal admission ownership", () => {
  it("rejects a pre-user admission commit after ownership replacement", async () => {
    // Given
    const { execution, host, state, threadKey } =
      await createReplacedExecution("pre-user");
    const { buffer, record } = createDurableThreadEventRecorder();

    // When
    const committing = commitPreUserRuntimeInputs(
      createDispatcher(host, state, threadKey),
      state,
      [{ input: userText("pre-user"), placement: "turn-start" }],
      host.attachmentStore,
      {
        commitRecordedEvents: () =>
          commitThreadStateAndEvents({
            buffer,
            executionHost: host,
            executionRun: execution,
            state,
            threadKey,
          }),
        recordEvent: record,
      }
    );

    // Then
    await expect(committing).rejects.toThrow(CONFLICT_PATTERN);
    await expect(host.store.threads.load(threadKey)).resolves.toBeNull();
    await expect(readEventTypes(host, threadKey)).resolves.toEqual([]);
  });

  it("rejects accepted ordinary input after ownership replacement", async () => {
    // Given
    const { execution, host, state, threadKey } =
      await createReplacedExecution("ordinary-input");
    const { buffer, record } = createDurableThreadEventRecorder();
    const input = userText("ordinary");
    state.appendUserInput(input);
    record(input);

    // When
    const committing = commitThreadStateAndEvents({
      buffer,
      executionHost: host,
      executionRun: execution,
      state,
      threadKey,
    });

    // Then
    await expect(committing).rejects.toThrow(CONFLICT_PATTERN);
    await expect(host.store.threads.load(threadKey)).resolves.toBeNull();
    await expect(readEventTypes(host, threadKey)).resolves.toEqual([]);
  });

  it("rejects accepted durable input and acknowledgement after replacement", async () => {
    // Given
    const { execution, host, state, threadKey } =
      await createReplacedExecution("durable-input");
    const input = userText("durable");
    await host.store.inputs.admit({
      input,
      kind: "send",
      messageId: "durable-message",
      threadKey,
    });
    const claim = await host.store.inputs.claimNext(threadKey, "turn-idle");
    if (!claim) {
      throw new Error("Expected a durable input claim.");
    }
    const { buffer, record } = createDurableThreadEventRecorder();
    state.appendUserInput(input);
    record(input);

    // When
    const committing = commitAndAckDurableThreadInput({
      buffer,
      executionHost: host,
      executionRun: execution,
      record: claim,
      state,
      threadKey,
    });

    // Then
    await expect(committing).rejects.toThrow(CONFLICT_PATTERN);
    await expect(host.store.threads.load(threadKey)).resolves.toBeNull();
    await expect(readEventTypes(host, threadKey)).resolves.toEqual([]);
    await expect(host.store.inputs.recoverClaims(threadKey)).resolves.toEqual({
      acked: [],
      released: [expect.objectContaining({ messageId: "durable-message" })],
    });
  });
});
