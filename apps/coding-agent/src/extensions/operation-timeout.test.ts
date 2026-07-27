import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingAgentExtensionError } from "./error";
import { raceWithExtensionTimeout } from "./operation-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("raceWithExtensionTimeout", () => {
  it("cancels the timeout timer when the task wins", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const task = Promise.resolve("ok");

    const result = await raceWithExtensionTimeout("ext", "hook", task, {
      timeoutMs: 10_000,
    });

    expect(result).toBe("ok");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("rejects when the timeout wins", async () => {
    vi.useFakeTimers();
    let resolveTask!: (value: string) => void;
    const task = new Promise<string>((resolve) => {
      resolveTask = resolve;
    });

    const pending = raceWithExtensionTimeout("ext", "hook", task, {
      timeoutMs: 25,
    });
    const expectation = expect(pending).rejects.toBeInstanceOf(
      CodingAgentExtensionError
    );

    await vi.advanceTimersByTimeAsync(25);
    await expectation;
    resolveTask("late");
  });

  it("rejects when the host signal aborts", async () => {
    const controller = new AbortController();
    const task = new Promise<string>(() => undefined);
    const pending = raceWithExtensionTimeout("ext", "event", task, {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      extensionId: "ext",
      phase: "event",
    });
  });
});
