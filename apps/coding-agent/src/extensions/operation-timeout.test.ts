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
    const { promise: task, resolve: resolveTask } = deferred<string>();

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

  it("rejects safely when inspecting the task rejection throws", async () => {
    // Given
    const hostileRejection = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap must not escape");
        },
      }
    );
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);

    try {
      // When
      const pending = raceWithExtensionTimeout(
        "ext",
        "hook",
        Promise.reject(hostileRejection),
        { timeoutMs: 10_000 }
      );

      // Then
      await expect(pending).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: "Extension operation rejected with an unsafe value",
        }),
        extensionId: "ext",
        message: 'Coding agent extension "ext" failed during hook',
        phase: "hook",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("observes a hostile task rejection after the timeout settles", async () => {
    // Given
    vi.useFakeTimers();
    const { promise: task, reject: rejectTask } = deferred<string>();
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);

    try {
      const pending = raceWithExtensionTimeout("ext", "event", task, {
        timeoutMs: 25,
      });
      const rejection = expect(pending).rejects.toBeInstanceOf(
        CodingAgentExtensionError
      );

      // When
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      rejectTask(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("late prototype trap must not escape");
            },
          }
        )
      );
      await Promise.resolve();
      await Promise.resolve();

      // Then
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("rejects a never-settling task on host abort when the timer is disabled", async () => {
    // Given
    const controller = new AbortController();
    const task = new Promise<string>(() => undefined);
    const pending = raceWithExtensionTimeout("ext", "event", task, {
      signal: controller.signal,
      timeoutMs: 0,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      extensionId: "ext",
      phase: "event",
    });

    // When
    controller.abort();

    // Then
    await rejection;
  });

  it("normalizes hostile task rejection when the timer is disabled", async () => {
    // Given
    const hostileRejection = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap must not escape");
        },
      }
    );

    // When
    const pending = raceWithExtensionTimeout(
      "ext",
      "hook",
      Promise.reject(hostileRejection),
      { timeoutMs: 0 }
    );

    // Then
    await expect(pending).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "Extension operation rejected with an unsafe value",
      }),
      extensionId: "ext",
      phase: "hook",
    });
  });

  it("removes the abort listener when a no-timer task settles", async () => {
    // Given
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    // When
    const result = await raceWithExtensionTimeout(
      "ext",
      "hook",
      Promise.resolve("ok"),
      { signal: controller.signal, timeoutMs: 0 }
    );

    // Then
    expect(result).toBe("ok");
    expect(removeListener).toHaveBeenCalledOnce();
    removeListener.mockRestore();
  });

  it("observes late task rejection when the host signal is pre-aborted", async () => {
    // Given
    const controller = new AbortController();
    controller.abort();
    const { promise: task, reject: rejectTask } = deferred<string>();
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);

    try {
      const pending = raceWithExtensionTimeout("ext", "event", task, {
        signal: controller.signal,
        timeoutMs: 0,
      });
      await expect(pending).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "aborted" }),
      });

      // When
      rejectTask(new Error("late"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Then
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
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

function deferred<Value>() {
  const control = {
    reject(_reason?: unknown): void {
      throw new TypeError("Deferred rejector was not initialized.");
    },
    resolve(_value: Value | PromiseLike<Value>): void {
      throw new TypeError("Deferred resolver was not initialized.");
    },
  };
  const promise = new Promise<Value>((resolve, reject) => {
    control.resolve = resolve;
    control.reject = reject;
  });
  return {
    promise,
    reject: (reason?: unknown) => control.reject(reason),
    resolve: (value: Value | PromiseLike<Value>) => control.resolve(value),
  };
}
