import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryAttachmentStore,
  MemoryThreadStore,
} from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import {
  encodeRuntimeAttachmentData,
  type RuntimeAttachmentReference,
} from "../input/attachments";
import { ThreadState } from "../state/thread-state";
import {
  compactThreadBlocking,
  selectSummaryOutputTokenLimit,
} from "./auto-compaction-runner";
import type { ThreadAutoCompactionOptions } from "./auto-compaction-types";

const contentTokens = (messages: readonly ModelMessage[]): number =>
  messages.reduce((total, message) => total + messageContentTokens(message), 0);

const compactionPolicy = (): ThreadAutoCompactionOptions => ({
  estimateTokens: contentTokens,
  maxInputTokens: 1000,
  retainTokens: 150,
  triggerTokens: 500,
});

const stateWithMessages = async (
  messages: readonly ModelMessage[]
): Promise<ThreadState> => {
  const state = new ThreadState({
    key: "auto-compaction-runner-test",
    store: new MemoryThreadStore(),
  });
  await state.ensureLoaded();
  for (const message of messages) {
    state.history.appendModelMessage(message);
  }
  return state;
};

const userMessage = (content: string): ModelMessage => ({
  content,
  role: "user",
});

const attachmentMessage = (ref: RuntimeAttachmentReference): ModelMessage => ({
  content: [
    {
      data: encodeRuntimeAttachmentData(ref),
      filename: "payload.bin",
      mediaType: "application/octet-stream",
      type: "file",
    },
  ],
  role: "user",
});

describe("selectSummaryOutputTokenLimit", () => {
  it("caps dense short ranges to half their input tokens", () => {
    expect(
      selectSummaryOutputTokenLimit({
        inputTokens: 700,
        retainTokens: 3200,
      })
    ).toBe(350);
  });

  it("keeps the policy-derived ceiling for large ranges", () => {
    expect(
      selectSummaryOutputTokenLimit({
        inputTokens: 50_000,
        retainTokens: 3200,
      })
    ).toBe(1600);
  });

  it("keeps a minimum viable summary budget", () => {
    expect(
      selectSummaryOutputTokenLimit({
        inputTokens: 300,
        retainTokens: 3200,
      })
    ).toBe(256);
  });
});

describe("compactThreadBlocking context estimation", () => {
  it("hydrates attachment payloads before selecting the compaction range", async () => {
    const attachmentStore = new MemoryAttachmentStore();
    const ref = await attachmentStore.put({
      bytes: new Uint8Array(800),
      filename: "payload.bin",
      mediaType: "application/octet-stream",
    });
    const state = await stateWithMessages([
      userMessage("u".repeat(100)),
      assistantMessage("a".repeat(100)),
      attachmentMessage(ref),
    ]);
    const compact = vi.fn(() => Promise.resolve(true));

    const compacted = await compactThreadBlocking({
      compact,
      model: {
        attachmentStore,
        model: createCallbackModel(() => [assistantMessage("short")]),
      },
      policy: compactionPolicy(),
      state,
    });

    expect(compacted).toBe(true);
    expect(compact).toHaveBeenCalledWith({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "short",
    });
  });

  it("counts observed model context transform overhead before selecting the compaction range", async () => {
    const messages = [
      userMessage("u".repeat(100)),
      assistantMessage("a".repeat(100)),
      userMessage("tail"),
    ];
    const state = await stateWithMessages(messages);
    const compact = vi.fn(() => Promise.resolve(true));
    const latestContextTransform = vi.fn(() => ({
      input: messages,
      output: [userMessage("ephemeral".repeat(70)), ...messages],
    }));

    const compacted = await compactThreadBlocking({
      compact,
      latestContextTransform,
      model: {
        model: createCallbackModel(() => [assistantMessage("short")]),
      },
      policy: compactionPolicy(),
      state,
    });

    expect(compacted).toBe(true);
    expect(latestContextTransform).toHaveBeenCalled();
    expect(compact).toHaveBeenCalledWith({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "short",
    });
  });
});

function messageContentTokens(message: ModelMessage): number {
  if (typeof message.content === "string") {
    return message.content.length;
  }

  return message.content.reduce((total, part) => {
    if (part.type === "text") {
      return total + part.text.length;
    }
    if (part.type === "file") {
      if (part.data instanceof Uint8Array) {
        return total + part.data.byteLength;
      }
      if (typeof part.data === "string") {
        return total + part.data.length;
      }
    }
    return total;
  }, 0);
}
