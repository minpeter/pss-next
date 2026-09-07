import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

const terminalHarness = vi.hoisted(() => ({
  send: undefined as ((data: string) => void) | undefined,
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();
  const noop = (): void => undefined;

  class TestTerminal implements Terminal {
    readonly clearFromCursor = noop;
    readonly clearLine = noop;
    readonly clearScreen = noop;
    readonly columns = 80;
    readonly hideCursor = noop;
    readonly kittyProtocolActive = false;
    readonly moveBy = noop;
    readonly rows = 24;
    readonly setProgress = noop;
    readonly setTitle = noop;
    readonly showCursor = noop;
    readonly stop = noop;
    readonly write = noop;

    drainInput(): Promise<void> {
      return Promise.resolve();
    }
    start(onInput: (data: string) => void): void {
      terminalHarness.send = onInput;
    }
  }

  return { ...actual, ProcessTerminal: TestTerminal };
});

import { type AgentTUIConfig, createAgentTUI } from "./agent";
import { TuiSessionMachine } from "./session-state";

const deferred = <T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
};

const submitModelCommandAfterSetup = (): void => {
  const original = TuiSessionMachine.prototype.awaitInput;
  const spy = vi
    .spyOn(TuiSessionMachine.prototype, "awaitInput")
    .mockImplementation(function (this: TuiSessionMachine, resolve) {
      original.call(this, resolve);
      spy.mockRestore();
      for (const input of "/model") {
        terminalHarness.send?.(input);
      }
      terminalHarness.send?.("\r");
    });
};

const requestExit = (): void => {
  process.emit("SIGINT", "SIGINT");
  process.emit("SIGINT", "SIGINT");
};

const baseConfig = (): Pick<
  AgentTUIConfig,
  "commands" | "onSetup" | "thread"
> => ({
  commands: [
    {
      description: "Select a model",
      execute: () => ({ action: { type: "select-model" }, success: true }),
      name: "model",
    },
  ],
  onSetup: submitModelCommandAfterSetup,
  thread: {
    interrupt: vi.fn(),
    send: vi.fn(() => {
      throw new Error("unexpected model turn");
    }),
    steer: vi.fn(() => {
      throw new Error("unexpected model steering");
    }),
  },
});

const expectExitBefore = async (
  run: Promise<void>,
  cleanup: () => void
): Promise<void> => {
  const timeout = deferred<never>();
  const signal = AbortSignal.timeout(250);
  signal.addEventListener(
    "abort",
    () =>
      timeout.reject(new Error("TUI did not exit after exit was requested")),
    { once: true }
  );

  try {
    await Promise.race([run, timeout.promise]);
  } finally {
    cleanup();
    await run;
  }
};

describe.sequential("TUI selector exit", () => {
  it("exits while the model catalog is loading", async () => {
    const catalog = deferred<string[]>();
    const loading = deferred<void>();
    const run = createAgentTUI({
      ...baseConfig(),
      modelSelector: {
        currentModelId: () => "model-a",
        listModelIds: () => {
          loading.resolve();
          return catalog.promise;
        },
        switchModel: vi.fn(),
      },
    });

    await loading.promise;
    requestExit();

    await expectExitBefore(run, () => catalog.resolve([]));
  });

  it("exits while the model selector is open and settles the selector itself", async () => {
    const opened = deferred<void>();
    const switchModel = vi.fn();
    const run = createAgentTUI({
      ...baseConfig(),
      modelSelector: {
        currentModelId: () => {
          opened.resolve();
          return "model-a";
        },
        listModelIds: () => Promise.resolve(["model-a"]),
        switchModel,
      },
    });

    await opened.promise;
    requestExit();

    // No manual Escape: exit must settle the selector through its own
    // cancellation path. A stale selection key sent after the TUI stopped
    // must not reach a leaked selector and switch the model.
    await expectExitBefore(run, () => undefined);
    terminalHarness.send?.("\r");
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("removes the selector abort listener after normal cancellation", async () => {
    const addEventListener = vi.spyOn(
      AbortSignal.prototype,
      "addEventListener"
    );
    const removeEventListener = vi.spyOn(
      AbortSignal.prototype,
      "removeEventListener"
    );
    const opened = deferred<void>();
    let listenersBeforeCommand = 0;
    const run = createAgentTUI({
      ...baseConfig(),
      onSetup: () => {
        listenersBeforeCommand = addEventListener.mock.calls.length;
        submitModelCommandAfterSetup();
      },
      modelSelector: {
        currentModelId: () => {
          opened.resolve();
          return "model-a";
        },
        listModelIds: () => Promise.resolve(["model-a"]),
        switchModel: vi.fn(),
      },
    });

    try {
      await opened.promise;
      const selectorAbortListeners = addEventListener.mock.calls
        .slice(listenersBeforeCommand)
        .filter(([type]) => type === "abort");
      expect(selectorAbortListeners).toHaveLength(1);
      const selectorAbortListener = selectorAbortListeners[0]?.[1];
      terminalHarness.send?.("\u001b");

      expect(removeEventListener).toHaveBeenCalledWith(
        "abort",
        selectorAbortListener
      );
    } finally {
      requestExit();
      await expectExitBefore(run, () => undefined);
      addEventListener.mockRestore();
      removeEventListener.mockRestore();
    }
  });
});
