import type { Terminal } from "@earendil-works/pi-tui";
import { describe, it, vi } from "vitest";

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
  // The outer microtask lets createAgentTUI continue past onSetup; the inner
  // one runs after its input waiter has been installed.
  queueMicrotask(() => {
    queueMicrotask(() => {
      for (const input of "/model") {
        terminalHarness.send?.(input);
      }
      terminalHarness.send?.("\r");
    });
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

  it("exits while the model selector is open", async () => {
    const opened = deferred<void>();
    const run = createAgentTUI({
      ...baseConfig(),
      modelSelector: {
        currentModelId: () => {
          opened.resolve();
          return "model-a";
        },
        listModelIds: () => Promise.resolve(["model-a"]),
        switchModel: vi.fn(),
      },
    });

    await opened.promise;
    requestExit();

    await expectExitBefore(run, () => terminalHarness.send?.("\u001b"));
  });
});
