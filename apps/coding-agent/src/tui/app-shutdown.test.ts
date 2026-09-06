import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionManager } from "../sessions/session-manager";
import { resolveSessionSelector } from "../sessions/session-resume";

const terminal = vi.hoisted(() => ({
  columns: 48,
  rows: 10,
  input: (_data: string): void => undefined,
  render: (): void => undefined,
  painted: (_data: string): void => undefined,
  stopped: (): void => undefined,
}));
const update = vi.hoisted(() => ({
  enabled: false,
  install: async () => 0,
}));

vi.mock("../update/cli-version", () => ({ cliVersion: "0.0.14" }));
vi.mock("../update/auto-update", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../update/auto-update")>();
  return {
    ...actual,
    planAutoUpdate: (...args: Parameters<typeof actual.planAutoUpdate>) =>
      update.enabled
        ? {
            channel: "latest",
            currentVersion: "0.0.14",
            manager: "pnpm",
            target: "0.0.15",
          }
        : actual.planAutoUpdate(...args),
    runAutoUpdate: (
      plan: Parameters<typeof actual.runAutoUpdate>[0],
      options: Parameters<typeof actual.runAutoUpdate>[1]
    ) =>
      actual.runAutoUpdate(plan, {
        ...options,
        fetchTags: async () => ({ latest: "0.0.15" }),
        spawnInstall: () => update.install(),
      }),
  };
});

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();
  const noop = () => undefined;
  class TestTerminal implements Terminal {
    get columns() {
      return terminal.columns;
    }
    get rows() {
      return terminal.rows;
    }
    readonly kittyProtocolActive = false;
    readonly clearFromCursor = noop;
    readonly clearLine = noop;
    readonly clearScreen = noop;
    readonly hideCursor = noop;
    readonly moveBy = noop;
    readonly setProgress = noop;
    readonly setTitle = noop;
    readonly showCursor = noop;
    write(data: string) {
      process.stdout.write(data);
      terminal.painted(data);
    }
    drainInput() {
      return Promise.resolve();
    }
    stop() {
      terminal.stopped();
    }
    start(input: (data: string) => void) {
      terminal.input = input;
    }
  }
  return { ...actual, ProcessTerminal: TestTerminal };
});

import { createAgentTUI } from "./agent";
import { startTui } from "./app";
import { TuiSessionMachine } from "./session-state";
import { formatSessionResumeHint } from "./terminal-exit";

const model = new MockLanguageModelV4({
  doStream: async () => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "answer" });
        controller.enqueue({
          type: "text-delta",
          id: "answer",
          delta: "answer",
        });
        controller.enqueue({ type: "text-end", id: "answer" });
        controller.enqueue({
          type: "finish",
          finishReason: { raw: "stop", unified: "stop" },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        });
        controller.close();
      },
    }),
  }),
});

const { Terminal: Xterm } = createRequire(import.meta.url)(
  "@xterm/xterm"
) as typeof import("@xterm/xterm");

async function screen(output: string) {
  const emulator = new Xterm({
    cols: terminal.columns,
    rows: terminal.rows,
    allowProposedApi: true,
    convertEol: true,
  });
  try {
    await new Promise<void>((resolve) => emulator.write(output, resolve));
    const buffer = emulator.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) =>
      buffer.getLine(row)?.translateToString(true).trimEnd()
    );
  } finally {
    emulator.dispose();
  }
}

async function expectFinalScreen(output: string, hint: string) {
  const rows = await screen(output);
  const rule = "─".repeat(terminal.columns);
  const hintRows = Array.from(
    { length: Math.ceil(hint.length / terminal.columns) },
    (_, index) =>
      hint.slice(index * terminal.columns, (index + 1) * terminal.columns)
  );
  const border = rows.indexOf(rule);
  expect(rows.filter((row) => row === rule)).toHaveLength(1);
  expect(rows.slice(border, border + hintRows.length + 1)).toEqual([
    rule,
    ...hintRows,
  ]);
  expect(rows.slice(border + hintRows.length + 1).every((row) => !row)).toBe(
    true
  );
  return rows;
}

function gate() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function onInputReady(action: () => void) {
  const original = TuiSessionMachine.prototype.awaitInput;
  const spy = vi
    .spyOn(TuiSessionMachine.prototype, "awaitInput")
    .mockImplementation(function (this: TuiSessionMachine, resolve) {
      original.call(this, resolve);
      spy.mockRestore();
      action();
    });
}

function exit() {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  terminal.input("\x03");
  clock.mockReturnValue(now + 100);
  terminal.input("\x03");
  clock.mockRestore();
}

describe.sequential("startTui final output", () => {
  let directory: string;
  let output: string[];
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pss-shutdown-"));
    output = [];
    terminal.columns = 48;
    terminal.rows = 10;
    const start = TuiMainScreen.prototype.start;
    vi.spyOn(TuiMainScreen.prototype, "start").mockImplementation(function (
      this: TuiMainScreen
    ) {
      start.call(this);
      terminal.render = () => this.renderNow();
    });
    vi.stubEnv("HOME", directory);
    vi.stubEnv("PSS_THREAD_DIR", join(directory, "threads"));
    vi.stubEnv("PSS_THREAD_KEY", "");
    vi.stubEnv("PSS_DISABLE_UPDATE_CHECK", "1");
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 48,
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    if (columns) {
      Object.defineProperty(process.stdout, "columns", columns);
    } else {
      Reflect.deleteProperty(process.stdout, "columns");
    }
    terminal.stopped = () => undefined;
    terminal.painted = () => undefined;
    update.enabled = false;
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    { columns: 100, rows: 32 },
    { columns: 48, rows: 10 },
  ])("reuses the idle composer border at $columns x $rows", async (size) => {
    Object.assign(terminal, size);
    Object.defineProperty(process.stdout, "columns", { value: size.columns });
    let painted = "";
    let hint = "";
    const run = startTui(
      { cwd: directory, model, tools: {}, sessionName: "named" },
      {
        createTui(config) {
          hint = formatSessionResumeHint(
            config.sessionSelector?.currentSessionKey() ?? ""
          );
          config.onSetup = () =>
            onInputReady(() => {
              terminal.render();
              painted = output.join("");
              exit();
            });
          return createAgentTUI(config);
        },
      }
    );
    expect(await run).toBe(0);
    const before = await screen(painted);
    const after = await screen(output.join(""));
    const border = before.indexOf("─".repeat(size.columns));
    const hintRow = after.findIndex((row) =>
      row?.startsWith(hint.slice(0, size.columns))
    );
    expect(border).toBeGreaterThanOrEqual(0);
    expect(hintRow).toBe(border + 1);
    expect(after[hintRow - 1]).toBe("─".repeat(size.columns));
    expect(
      after.filter((row) => row === "─".repeat(size.columns))
    ).toHaveLength(1);
    expect(after.slice(0, border)).toEqual(before.slice(0, border));
    expect(output.join("").split(hint)).toHaveLength(2);
  });

  it("retains the streamed transcript and one composer border after narrow scrolling", async () => {
    const marker = "STREAM_SENTINEL";
    let hint = "";
    terminal.painted = (data) => {
      if (data.includes(marker)) {
        terminal.painted = () => undefined;
        queueMicrotask(exit);
      }
    };
    const streaming = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "answer" });
            controller.enqueue({
              type: "text-delta",
              id: "answer",
              delta: `${marker}\n\n`.repeat(35),
            });
            abortSignal?.addEventListener(
              "abort",
              () => controller.error(abortSignal.reason),
              { once: true }
            );
          },
        }),
      }),
    });
    const run = startTui(
      { cwd: directory, model: streaming, tools: {}, sessionName: "named" },
      {
        createTui(config) {
          hint = formatSessionResumeHint(
            config.sessionSelector?.currentSessionKey() ?? ""
          );
          config.onSetup = () =>
            onInputReady(() => {
              for (const key of "go\r") {
                terminal.input(key);
              }
            });
          return createAgentTUI(config);
        },
      }
    );
    expect(await run).toBe(0);
    const rows = await expectFinalScreen(output.join(""), hint);
    expect(rows.filter((row) => row?.includes(marker))).toHaveLength(35);
    expect(output.join("").split(hint)).toHaveLength(2);
  });

  it("restores one narrow composer rule and exactly one real current selector after owned extension logging", async () => {
    // Given: real session storage, host, TUI and bounded asynchronous observer.
    const shutdown = gate();
    const release = gate();
    const run = startTui(
      {
        cwd: directory,
        model,
        tools: {},
        extensions: [
          {
            id: "shutdown-log",
            configure() {
              /* Lifecycle-only fixture. */
            },
            activate({ services }) {
              services.events.on("host:session-shutdown", async () => {
                shutdown.resolve();
                await release.promise;
                process.stdout.write("OBSERVER_SENTINEL\n");
              });
              return () => {
                services.logger.info("DISPOSE_SENTINEL");
              };
            },
          },
        ],
      },
      {
        createTui(config) {
          config.onSetup = () => onInputReady(exit);
          return createAgentTUI(config);
        },
      }
    );
    // When
    await shutdown.promise;
    release.resolve();
    expect(await run).toBe(0);
    // Then: resolve the printed selector against the actual final disk index.
    const manager = createSessionManager({
      cwd: directory,
      directory: join(directory, "threads"),
    });
    const [session] = await manager.listSessions();
    if (!session) {
      throw new Error("No persisted session");
    }
    const hint = formatSessionResumeHint(session.key);
    const text = output.join("");
    const selector = hint.split("--session ")[1];
    expect(await resolveSessionSelector(manager, selector ?? "")).toBe(
      session.key
    );
    expect(text.split(hint)).toHaveLength(2);
    expect(text.endsWith(`${"─".repeat(48)}\n${hint}\n`)).toBe(true);
    expect(text.indexOf("OBSERVER_SENTINEL")).toBeLessThan(text.indexOf(hint));
    expect(text.indexOf("DISPOSE_SENTINEL")).toBeLessThan(text.indexOf(hint));
    const rows = await expectFinalScreen(text, hint);
    expect(rows.some((row) => row?.includes("OBSERVER_SENTINEL"))).toBe(true);
    expect(rows.some((row) => row?.includes("DISPOSE_SENTINEL"))).toBe(true);
  });

  it("settles detached completion errors before the final block", async () => {
    // Given: a completion callback released by the real terminal stop event.
    const stopped = gate();
    const logged = gate();
    terminal.stopped = stopped.resolve;
    let hint = "";
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      output.push(`${args.map((value) => inspect(value)).join(" ")}\n`);
      logged.resolve();
    });
    const run = startTui(
      { cwd: directory, model, tools: {}, sessionName: "named" },
      {
        createTui(config) {
          config.onSetup = () =>
            onInputReady(() => {
              for (const key of "go\r") {
                terminal.input(key);
              }
            });
          hint = formatSessionResumeHint(
            config.sessionSelector?.currentSessionKey() ?? ""
          );
          config.onTurnComplete = async () => {
            onInputReady(exit);
            await stopped.promise;
            throw new Error("CALLBACK_SENTINEL");
          };
          return createAgentTUI(config);
        },
      }
    );
    // When
    await Promise.all([run, logged.promise]);
    // Then
    const text = output.join("");
    expect(text.indexOf("CALLBACK_SENTINEL")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("CALLBACK_SENTINEL")).toBeLessThan(
      text.indexOf("To resume this session:")
    );
    const rows = await expectFinalScreen(text, hint);
    expect(rows.some((row) => row?.includes("CALLBACK_SENTINEL"))).toBe(true);
  });

  it("reports setup and cleanup failures before the only final block", async () => {
    // Given: two independent failures; cleanup must still execute.
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      output.push(inspect(args));
    });
    // When
    const code = await startTui(
      {
        cwd: directory,
        model,
        tools: {},
        extensions: [
          {
            id: "failing-cleanup",
            configure() {
              /* Lifecycle-only fixture. */
            },
            activate() {
              return () => {
                throw new Error("CLEANUP_FAILURE_SENTINEL");
              };
            },
          },
        ],
      },
      {
        createTui(config) {
          config.onSetup = () => {
            throw new Error("SETUP_FAILURE_SENTINEL");
          };
          return createAgentTUI(config);
        },
      }
    );
    // Then
    const text = output.join("");
    expect(code).toBe(1);
    for (const sentinel of [
      "SETUP_FAILURE_SENTINEL",
      "CLEANUP_FAILURE_SENTINEL",
    ]) {
      expect(text.indexOf(sentinel), text).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(sentinel)).toBeLessThan(
        text.indexOf("To resume this session:")
      );
    }
    expect(text.split("To resume this session:")).toHaveLength(2);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("cancels and bounds an uncooperative completion without a late owned error logger", async () => {
    // Given: fake only the deadline after startup; no filesystem or TUI state polling.
    const stopped = gate();
    const callback = gate();
    let signal: AbortSignal | undefined;
    terminal.stopped = stopped.resolve;
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        output.push(inspect(args));
      });
    const run = startTui(
      { cwd: directory, model, tools: {}, sessionName: "named" },
      {
        createTui(config) {
          config.onSetup = () =>
            onInputReady(() => {
              for (const key of "go\r") {
                terminal.input(key);
              }
            });
          config.onTurnComplete = (_usage, _reason, callbackSignal) => {
            signal = callbackSignal;
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            onInputReady(exit);
            return callback.promise;
          };
          return createAgentTUI(config);
        },
      }
    );
    // When: advance the actual bounded callback deadline after terminal teardown.
    await stopped.promise;
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    const beforeLateRejection = output.join("");
    const rejected = expect(callback.promise).rejects.toThrow("LATE_SENTINEL");
    callback.reject(new Error("LATE_SENTINEL"));
    await rejected;
    // Then: the timeout was reported once before the block; late rejection is observed, not re-logged.
    expect(errorLog).toHaveBeenCalledOnce();
    expect(beforeLateRejection.indexOf("10000ms")).toBeLessThan(
      beforeLateRejection.indexOf("To resume this session:")
    );
    expect(output.join("")).toBe(beforeLateRejection);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the built-in title provider before printing the resume block", async () => {
    // Given: title generation is real app-owned completion work, not an injected callback.
    const generating = gate();
    const aborted = gate();
    const titleModel = new MockLanguageModelV4({
      doStream: model.doStream,
      doGenerate: (options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(options.abortSignal?.reason);
            },
            { once: true }
          );
          generating.resolve();
        }),
    });
    const run = startTui(
      { cwd: directory, model: titleModel, tools: {} },
      {
        createTui(config) {
          config.onSetup = () =>
            onInputReady(() => {
              for (const key of "go\r") {
                terminal.input(key);
              }
            });
          return createAgentTUI(config);
        },
      }
    );
    // When
    await generating.promise;
    exit();
    await aborted.promise;
    expect(await run).toBe(0);
    // Then: cancelled title work does not rename the current session afterward.
    const manager = createSessionManager({
      cwd: directory,
      directory: join(directory, "threads"),
    });
    const [session] = await manager.listSessions();
    expect(session?.name).toBeUndefined();
    expect(output.join("").split("To resume this session:")).toHaveLength(2);
  });

  it("bounds uncooperative host cleanup and reports its deadline before the final block", async () => {
    // Given: host cancellation is observed but this cleanup refuses to settle.
    const cleaning = gate();
    const cleanup = gate();
    let signal: AbortSignal | undefined;
    let log: ((message: string) => void) | undefined;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      output.push(inspect(args));
    });
    const run = startTui(
      {
        cwd: directory,
        model,
        tools: {},
        extensions: [
          {
            id: "uncooperative-cleanup",
            configure() {
              /* Lifecycle-only fixture. */
            },
            activate(context) {
              signal = context.signal;
              log = context.services.logger.info;
              return () => {
                cleaning.resolve();
                return cleanup.promise;
              };
            },
          },
        ],
      },
      {
        createTui(config) {
          config.onSetup = () =>
            onInputReady(() => {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
              exit();
            });
          return createAgentTUI(config);
        },
      }
    );
    // When
    await cleaning.promise;
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run).toBe(1);
    // Then
    const text = output.join("");
    expect(text.indexOf("10000ms")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("10000ms")).toBeLessThan(
      text.indexOf("To resume this session:")
    );
    expect(() => log?.("LATE_LOG_SENTINEL")).toThrow();
    expect(output.join("")).toBe(text);
    cleanup.resolve();
    await cleanup.promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1])(
    "settles optional auto-update exit %s before the final block",
    async (code) => {
      // Given: the real updater with local tags and an event-gated installer.
      const started = gate();
      const release = gate();
      update.enabled = true;
      update.install = async () => {
        started.resolve();
        await release.promise;
        process.stdout.write("INSTALL_SENTINEL\n");
        return code;
      };
      const run = startTui(
        { cwd: directory, model, tools: {} },
        {
          createTui(config) {
            config.onSetup = () => onInputReady(exit);
            return createAgentTUI(config);
          },
        }
      );
      // When
      await started.promise;
      expect(output.join("").includes("To resume this session:")).toBe(false);
      release.resolve();
      expect(await run).toBe(code);
      // Then
      const text = output.join("");
      expect(text.indexOf("INSTALL_SENTINEL")).toBeLessThan(
        text.indexOf("To resume this session:")
      );
      expect(text.split("To resume this session:")).toHaveLength(2);
      expect(text.endsWith("\n")).toBe(true);
    }
  );
});
