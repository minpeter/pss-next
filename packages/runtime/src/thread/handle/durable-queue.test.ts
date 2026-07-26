import { describe, expect, it } from "vitest";
import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import type { AgentHooks } from "../../agent/core/hooks";
import type {
  AgentHost,
  ThreadInputInbox,
  ThreadInputRecord,
} from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { MemoryAttachmentStore } from "../../platform/memory/storage/memory-attachment-store";
import { solidTestPng } from "../../testing/valid-image-fixture";
import type {
  HostAttachmentStore,
  RuntimeAttachmentBlob,
  RuntimeAttachmentPutInput,
  RuntimeAttachmentReference,
} from "../input/attachments";
import type { UserInput } from "../input/input";
import { BufferedAgentTurn } from "../protocol/turn";
import { ThreadEventDispatcher } from "../runtime/thread-event-dispatcher";
import { createQueuedSendInput } from "./durable-queue-send";

describe("createQueuedSendInput", () => {
  it("deletes hook-transformed attachment bytes when durable admission dedupes", async () => {
    const attachmentStore = new TrackingAttachmentStore();
    const hookRuntime = new AgentHookRuntime(transformTextToFileInputHooks());
    const events = new ThreadEventDispatcher({
      attachmentStore,
      history: () => [],
      hookRuntime,
      signal: () => undefined,
      threadKey: "hook-duplicate",
    });

    const result = await createQueuedSendInput({
      attachmentStore,
      awaitBoundaries: false,
      events,
      executionHost: duplicateAdmissionHost(),
      input: "turn text",
      pendingOverlays: [],
      pendingRuntimeInputs: [],
      run: new BufferedAgentTurn(),
      threadKey: "hook-duplicate",
    });

    expect(result.kind).toBe("handled");
    expect(attachmentStore.putCount).toBe(1);
    expect(attachmentStore.deletedRefs).toHaveLength(1);
    const ref = attachmentStore.deletedRefs[0];
    if (!ref) {
      throw new Error("expected hook-transformed attachment ref cleanup");
    }
    await expect(attachmentStore.get(ref)).resolves.toBeNull();
  });

  it("deletes staged attachment bytes dropped by a successful hook transform", async () => {
    const attachmentStore = new TrackingAttachmentStore();
    const hookRuntime = new AgentHookRuntime(transformAnyInputToTextHooks());
    const events = new ThreadEventDispatcher({
      attachmentStore,
      history: () => [],
      hookRuntime,
      signal: () => undefined,
      threadKey: "hook-transform",
    });

    const result = await createQueuedSendInput({
      attachmentStore,
      awaitBoundaries: false,
      events,
      executionHost: undefined,
      input: [
        {
          data: solidTestPng(),
          filename: "discarded.png",
          mediaType: "image/png",
          type: "file",
        },
      ],
      pendingOverlays: [],
      pendingRuntimeInputs: [],
      run: new BufferedAgentTurn(),
      threadKey: "hook-dropped",
    });

    expect(result.kind).toBe("queued");
    expect(attachmentStore.putCount).toBe(1);
    expect(attachmentStore.deletedRefs).toHaveLength(1);
    const ref = attachmentStore.deletedRefs[0];
    if (!ref) {
      throw new Error("expected dropped attachment ref cleanup");
    }
    await expect(attachmentStore.get(ref)).resolves.toBeNull();
  });
});

function transformTextToFileInputHooks(): AgentHooks {
  return {
    acceptInput: (event) => {
      if (event.type !== "user-input") {
        return { action: "continue" };
      }

      return {
        action: "transform",
        value: {
          content: [
            {
              data: solidTestPng(),
              filename: "hook.png",
              mediaType: "image/png",
              type: "file",
            },
          ],
          type: "user-input",
        },
      };
    },
  };
}

function transformAnyInputToTextHooks(): AgentHooks {
  return {
    acceptInput: (event) => {
      if (event.type !== "user-input") {
        return { action: "continue" };
      }

      return {
        action: "transform",
        value: {
          text: "hook replacement",
          type: "user-input",
        },
      };
    },
  };
}

function duplicateAdmissionHost(): AgentHost {
  const base = createInMemoryHost();
  const inputs = duplicateAdmissionInbox(base.store.inputs);
  return {
    ...base,
    store: {
      ...base.store,
      inputs,
      transaction: (callback) =>
        base.store.transaction((transaction) =>
          callback({ ...transaction, inputs })
        ),
    },
  };
}

function duplicateAdmissionInbox(base: ThreadInputInbox): ThreadInputInbox {
  return {
    ack: (record) => base.ack(record),
    admit: (input) =>
      Promise.resolve({
        duplicate: true,
        record: threadInputRecord(input.input, input.kind, input.messageId),
      }),
    claimNext: (threadKey, boundary, options) =>
      base.claimNext(threadKey, boundary, options),
    markPromoted: (record) => base.markPromoted(record),
    recoverClaims: (threadKey) => base.recoverClaims(threadKey),
    releaseClaim: (record) => base.releaseClaim(record),
  };
}

function threadInputRecord(
  input: UserInput,
  kind: ThreadInputRecord["kind"],
  messageId: string
): ThreadInputRecord {
  return {
    admittedAtMs: 1,
    admittedSeq: 1,
    input,
    kind,
    messageId,
    status: "pending",
    threadKey: "hook-duplicate",
  };
}

class TrackingAttachmentStore implements HostAttachmentStore {
  readonly #store = new MemoryAttachmentStore();
  readonly deletedRefs: RuntimeAttachmentReference[] = [];
  #putCount = 0;

  get putCount(): number {
    return this.#putCount;
  }

  async delete(ref: RuntimeAttachmentReference): Promise<void> {
    this.deletedRefs.push(ref);
    await this.#store.delete(ref);
  }

  get(ref: RuntimeAttachmentReference): Promise<RuntimeAttachmentBlob | null> {
    return this.#store.get(ref);
  }

  async put(
    input: RuntimeAttachmentPutInput
  ): Promise<RuntimeAttachmentReference> {
    this.#putCount += 1;
    return await this.#store.put(input);
  }
}
