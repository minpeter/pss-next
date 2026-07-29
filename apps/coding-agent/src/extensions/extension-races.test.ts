import { instructions } from "@minpeter/pss-extension-api";
import { afterEach, describe, expect, it, vi } from "vitest";

const commitSpy = vi.hoisted(() => vi.fn());

vi.mock("./registry-collections", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./registry-collections")>();
  return {
    ...original,
    commitExtensionRegistryCollections: (
      ...args: Parameters<typeof original.commitExtensionRegistryCollections>
    ) => {
      commitSpy();
      return original.commitExtensionRegistryCollections(...args);
    },
  };
});

import { createCodingAgentExtensionHost } from "./host";

afterEach(() => {
  vi.useRealTimers();
  commitSpy.mockClear();
});

describe("extension registration races", () => {
  it("closes a synchronous factory before its queued microtasks", async () => {
    const completed = deferred<void>();
    let lateError: unknown;
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          queueMicrotask(() => {
            try {
              pss.provide(instructions("late instruction"));
            } catch (error) {
              lateError = error;
            } finally {
              completed.resolve();
            }
          });
        },
        id: "sync-factory",
      },
    ]);

    await completed.promise;
    try {
      expect(lateError).toMatchObject({
        message: 'Coding agent extension "sync-factory" registration is closed',
      });
      expect(host.instructionFragments).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it("keeps registration open while an async factory is pending", async () => {
    const host = await createCodingAgentExtensionHost([
      {
        async default(pss) {
          await Promise.resolve();
          pss.provide(instructions("async instruction"));
        },
        id: "async-factory",
      },
    ]);

    try {
      expect(host.instructionFragments).toEqual(["async instruction"]);
    } finally {
      await host.dispose();
    }
  });

  it("does not commit after configure times out", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const release = deferred<void>();
    const finished = deferred<void>();
    const creation = createCodingAgentExtensionHost(
      [
        {
          async configure(registry) {
            registry.instructions.append("timed-out instruction");
            entered.resolve();
            await release.promise;
            finished.resolve();
          },
          id: "timed-out-extension",
        },
      ],
      { timeoutMs: 5 }
    );
    const rejection = expect(creation).rejects.toMatchObject({
      cause: { message: "Coding agent extension timed out after 5ms" },
    });

    await entered.promise;
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
    expect(commitSpy).not.toHaveBeenCalled();

    release.resolve();
    await finished.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("does not commit when configure resolves from timeout abort", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const creation = createCodingAgentExtensionHost(
      [
        {
          configure(registry, { signal }) {
            registry.instructions.append("abort-resolved instruction");
            entered.resolve();
            return new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
          id: "abort-resolved-extension",
        },
      ],
      { timeoutMs: 5 }
    );
    const rejection = expect(creation).rejects.toMatchObject({
      cause: { message: "Coding agent extension timed out after 5ms" },
    });

    await entered.promise;
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
    await Promise.resolve();
    await Promise.resolve();

    expect(commitSpy).not.toHaveBeenCalled();
  });
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
