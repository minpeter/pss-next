import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAttachmentStore } from "../platform/memory";
import {
  fakeModel,
  getGenerateTextMock,
  loadModelStepRunner,
} from "../testing/llm-test-utils";
import { assistantMessage } from "../testing/test-fixtures";
import {
  encodeRuntimeAttachmentData,
  RuntimeAttachmentHydrationError,
} from "../thread/input/attachments";

const generateTextMock = getGenerateTextMock();

describe("model attachment hydration", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  it("hydrates internal attachment refs into transient file bytes before generateText", async () => {
    const attachmentStore = new MemoryAttachmentStore();
    const bytes = new Uint8Array([1, 3, 5, 7]);
    const ref = await attachmentStore.put({
      bytes,
      filename: "photo.png",
      mediaType: "image/png",
    });
    const history = userHistoryWithAttachment(encodeRuntimeAttachmentData(ref));
    const runModelStep = await loadModelStepRunner();

    await runModelStep(
      { attachmentStore, model: fakeModel },
      { history, signal: new AbortController().signal }
    );

    expect(generateTextMock.mock.calls.at(-1)?.[0].messages).toEqual([
      {
        content: [
          { text: "describe", type: "text" },
          {
            data: bytes,
            filename: "photo.png",
            mediaType: "image/png",
            type: "file",
          },
        ],
        role: "user",
      },
    ]);
    expect(history[0]?.content).toEqual([
      { text: "describe", type: "text" },
      {
        data: encodeRuntimeAttachmentData(ref),
        filename: "photo.png",
        mediaType: "image/png",
        type: "file",
      },
    ]);
  });

  it("estimates hydrated attachment bytes by metadata for the default context gate", async () => {
    const attachmentStore = new MemoryAttachmentStore();
    const bytes = new Uint8Array(1024);
    const ref = await attachmentStore.put({
      bytes,
      filename: "photo.png",
      mediaType: "image/png",
    });
    const runModelStep = await loadModelStepRunner();

    await runModelStep(
      {
        attachmentStore,
        contextGate: { maxInputTokens: () => 200 },
        model: fakeModel,
      },
      {
        history: userHistoryWithAttachment(encodeRuntimeAttachmentData(ref)),
        signal: new AbortController().signal,
      }
    );

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls.at(-1)?.[0].messages).toEqual([
      {
        content: [
          { text: "describe", type: "text" },
          {
            data: bytes,
            filename: "photo.png",
            mediaType: "image/png",
            type: "file",
          },
        ],
        role: "user",
      },
    ]);
  });

  it("fails before provider calls when history contains refs without an attachment store", async () => {
    const attachmentStore = new MemoryAttachmentStore();
    const ref = await attachmentStore.put({
      bytes: new Uint8Array([2, 4, 6, 8]),
      filename: "photo.png",
      mediaType: "image/png",
    });
    const runModelStep = await loadModelStepRunner();

    await expect(
      runModelStep(
        { model: fakeModel },
        {
          history: userHistoryWithAttachment(encodeRuntimeAttachmentData(ref)),
          signal: new AbortController().signal,
        }
      )
    ).rejects.toBeInstanceOf(RuntimeAttachmentHydrationError);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("fails before provider calls when an attachment ref is missing", async () => {
    const attachmentStore = new MemoryAttachmentStore();
    const runModelStep = await loadModelStepRunner();

    await expect(
      runModelStep(
        { attachmentStore, model: fakeModel },
        {
          history: userHistoryWithAttachment(
            encodeRuntimeAttachmentData({
              id: "missing-blob",
              schemaVersion: 1,
            })
          ),
          signal: new AbortController().signal,
        }
      )
    ).rejects.toBeInstanceOf(RuntimeAttachmentHydrationError);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

function userHistoryWithAttachment(data: string): ModelMessage[] {
  return [
    {
      content: [
        { text: "describe", type: "text" },
        {
          data,
          filename: "photo.png",
          mediaType: "image/png",
          type: "file",
        },
      ],
      role: "user",
    },
  ];
}
