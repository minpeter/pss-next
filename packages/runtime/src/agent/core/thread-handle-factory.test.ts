import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { AgentThread } from "../../thread/handle/agent-thread";
import { createThreadPublicHandle } from "./thread-handle-factory";

const createThread = (): AgentThread =>
  new AgentThread(
    {
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    },
    {
      key: "lifecycle",
      store: {
        commit: () => Promise.resolve({ ok: true, version: "1" }),
        delete: () => Promise.resolve(),
        load: () => Promise.resolve(null),
      },
    }
  );

describe("createThreadPublicHandle", () => {
  it("evicts a terminal handle after disposal rejects", async () => {
    // Given
    const thread = createThread();
    const failure = new Error("dispose failed after kill");
    vi.spyOn(thread, "dispose").mockRejectedValue(failure);
    vi.spyOn(thread, "isOpen").mockReturnValue(false);
    const evict = vi.fn();
    const handle = createThreadPublicHandle({
      evict,
      instrumentations: [],
      key: "lifecycle",
      namespace: undefined,
      thread,
    });

    // When
    const disposal = handle.dispose();

    // Then
    await expect(disposal).rejects.toBe(failure);
    expect(evict).toHaveBeenCalledWith("lifecycle", handle);
    await expect(handle.delete()).rejects.toThrow("disposed");
  });

  it("retains an open handle after disposal rejects", async () => {
    // Given
    const thread = createThread();
    const failure = new Error("dispose failed before kill");
    vi.spyOn(thread, "dispose")
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();
    vi.spyOn(thread, "isOpen").mockReturnValue(true);
    const evict = vi.fn();
    const handle = createThreadPublicHandle({
      evict,
      instrumentations: [],
      key: "lifecycle",
      namespace: undefined,
      thread,
    });

    // When
    const firstDisposal = handle.dispose();

    // Then
    await expect(firstDisposal).rejects.toBe(failure);
    expect(evict).not.toHaveBeenCalled();
    await expect(handle.dispose()).resolves.toBeUndefined();
    expect(evict).toHaveBeenCalledWith("lifecycle", handle);
  });
});
