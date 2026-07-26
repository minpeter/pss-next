import { afterEach, describe, expect, it, vi } from "vitest";
import { runExtensionOperation } from "./host-operation";

afterEach(() => {
  vi.useRealTimers();
});

describe("runExtensionOperation late cleanup", () => {
  it("invokes cleanup returned after an activation timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let resolveActivate!: (cleanup: () => void) => void;
    const lateCleanup = vi.fn();
    const onLateResult = vi.fn(async (result: (() => void) | undefined) => {
      if (typeof result === "function") {
        await result();
      }
    });

    const pending = runExtensionOperation({
      callback: () =>
        new Promise<() => void>((resolve) => {
          resolveActivate = resolve;
        }),
      controller,
      extensionId: "slow",
      hasInteractiveUiRequests: () => false,
      onLateResult,
      phase: "activate",
      timeoutMs: 10,
    });

    const expectation = expect(pending).rejects.toMatchObject({
      extensionId: "slow",
      phase: "activate",
    });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;

    resolveActivate(lateCleanup);
    await vi.waitFor(() => {
      expect(onLateResult).toHaveBeenCalled();
    });
    expect(lateCleanup).toHaveBeenCalledTimes(1);
  });
});
