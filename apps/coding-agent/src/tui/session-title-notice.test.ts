import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Component,
  stripTerminalSequences,
  type Terminal,
  type TuiMainScreen,
} from "@earendil-works/pi-tui";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  input: (_data: string): void => undefined,
  screen: undefined as TuiMainScreen | undefined,
}));
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();
  const noop = () => undefined;
  class LocalTerminal implements Terminal {
    columns = 120;
    rows = 40;
    kittyProtocolActive = false;
    clearFromCursor = noop;
    clearLine = noop;
    clearScreen = noop;
    hideCursor = noop;
    moveBy = noop;
    setProgress = noop;
    setTitle = noop;
    showCursor = noop;
    stop = noop;
    write = noop;
    drainInput() {
      return Promise.resolve();
    }
    start(input: (data: string) => void) {
      terminal.input = input;
    }
  }
  class LocalScreen extends actual.TuiMainScreen {
    override start() {
      terminal.screen = this;
      super.start();
    }
  }
  return {
    ...actual,
    ProcessTerminal: LocalTerminal,
    TuiMainScreen: LocalScreen,
  };
});

import { type AgentTUIConfig, createAgentTUI } from "./agent";
import { startTui } from "./app";
import { TuiSessionMachine } from "./session-state";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Missing title fixture event")),
          5000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function idle() {
  const ready = gate();
  const original = TuiSessionMachine.prototype.awaitInput;
  const spy = vi
    .spyOn(TuiSessionMachine.prototype, "awaitInput")
    .mockImplementation(function (this: TuiSessionMachine, resolve) {
      original.call(this, resolve);
      spy.mockRestore();
      ready.resolve();
    });
  return bounded(ready.promise);
}
function surface() {
  if (!terminal.screen) {
    throw new Error("TUI not mounted");
  }
  return terminal.screen;
}
const lines = (component: Component = surface().children[1]) =>
  stripTerminalSequences(component.render(120).join("\n"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const send = (text: string) => {
  for (const char of text) {
    terminal.input(char);
  }
};
async function command(text: string) {
  const ready = idle();
  send(`${text}\r`);
  await ready;
}
function rendered(predicate: () => boolean) {
  const ready = gate();
  const screen = surface();
  const original = screen.requestRender.bind(screen);
  const spy = vi.spyOn(screen, "requestRender").mockImplementation((force) => {
    original(force);
    if (predicate()) {
      spy.mockRestore();
      ready.resolve();
    }
  });
  return bounded(ready.promise).finally(() => spy.mockRestore());
}
const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const finishReason = { raw: "stop", unified: "stop" } as const;
let directory: string;
let config: AgentTUIConfig;
let run: Promise<number> | undefined;
let generate: ReturnType<typeof vi.fn>;
async function fixture(failTitle = false) {
  const doGenerate = vi.fn(() => {
    if (failTitle) {
      return Promise.reject(new Error("TITLE_PROVIDER_ERROR"));
    }
    return Promise.resolve({
      content: [{ type: "text" as const, text: "자동 제목 TITLE_A" }],
      finishReason,
      usage,
      warnings: [],
    });
  });
  generate = doGenerate;
  const model = new MockLanguageModelV4({
    doGenerate,
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "answer" });
          controller.enqueue({
            type: "text-delta",
            id: "answer",
            delta: "ANSWER_SENTINEL",
          });
          controller.enqueue({ type: "text-end", id: "answer" });
          controller.enqueue({ type: "finish", finishReason, usage });
          controller.close();
        },
      }),
    }),
  });
  const ready = idle();
  run = startTui(
    { cwd: directory, model, tools: {} },
    {
      createTui(value) {
        config = value;
        return createAgentTUI(value);
      },
    }
  );
  await ready;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pss-title-notice-"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("PSS_THREAD_DIR", join(directory, "threads"));
  vi.stubEnv("PSS_THREAD_KEY", "");
  vi.stubEnv("PSS_DISABLE_UPDATE_CHECK", "1");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(async () => {
  try {
    if (run) {
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      expect(await bounded(run)).toBe(0);
    }
  } finally {
    run = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

describe.sequential("session title notices through startTui", () => {
  it("emits one automatic title row after completion without duplicating model/cwd or changing COLD", async () => {
    await fixture();
    const header = lines(surface().children[0]);
    const done = rendered(() =>
      lines().some((line) => line.includes("TITLE_A"))
    );
    await command("USER_SENTINEL");
    await done;
    expect(generate).toHaveBeenCalledTimes(1);
    expect(lines()).toHaveLength(3);
    expect(lines().filter((line) => line.includes("TITLE_A"))).toHaveLength(1);
    expect(lines().at(-1)).toBe(
      'Session title updated to "자동 제목 TITLE_A".'
    );
    expect(lines().join("\n")).not.toContain(directory);
    expect(lines().join("\n")).not.toContain(header[1]);
    expect(lines(surface().children[0])).toEqual(header);
    const before = lines();
    await command("/name 자동 제목 TITLE_A");
    expect(lines()).toEqual(before);
  });

  it("renders a direct rename once and retains navigation", async () => {
    await fixture();
    const header = lines(surface().children[0]);
    await command("/name 직접 TITLE_B");
    expect(lines()).toEqual(['Session title updated to "직접 TITLE_B".']);
    expect(lines(surface().children[0])).toEqual(header);
    const before = lines();
    await command("/name 직접 TITLE_B");
    expect(lines()).toEqual(before);
    await command("/name");
    expect(lines()).toHaveLength(2);
    await command("/new SESSION_NEXT");
    expect(lines().join("\n")).toContain(directory);
    expect(lines().join("\n")).toContain("SESSION_NEXT");
    expect(lines(surface().children[0])).toEqual(header);
  });

  it("reports the persisted fallback, not a failed generated title", async () => {
    await fixture(true);
    const done = rendered(() => lines().length > 2);
    await command("FALLBACK_TITLE");
    await done;
    expect(generate).toHaveBeenCalled();
    expect(lines()).toHaveLength(3);
    expect(lines().at(-1)).toBe('Session title updated to "FALLBACK_TITLE".');
    expect(lines().join("\n")).not.toContain("TITLE_PROVIDER_ERROR");
  });

  it("renders structured title metadata safely without relying on subtitle changes", async () => {
    await fixture();
    const name = '제목 "quoted"\nnext\t\x1b[2J\x1b]52;c;payload\x07\u2028end';
    const current = config.currentSession?.();
    if (!current) {
      throw new Error("Missing session metadata");
    }
    config.onTurnComplete = () => {
      config.currentSession = () => ({ ...current, name });
      config.footer = { text: "FOOTER_UPDATED" };
    };
    const done = rendered(() =>
      lines().some((line) => line.includes("quoted"))
    );
    await command("USER_SENTINEL");
    await done;
    expect(lines()).toHaveLength(3);
    expect(lines().at(-1)).toBe(
      'Session title updated to "제목 "quoted"^Jnext^I^[[2J^[]52;c;payload^Gend".'
    );
    expect(lines(surface().children.at(-1))).toContain("FOOTER_UPDATED");
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not claim a title when completion yields no metadata change", async () => {
    await fixture();
    config.onTurnComplete = () => undefined;
    const done = rendered(() => lines().length === 2);
    await command("USER_SENTINEL");
    await done;
    expect(lines()).toEqual(["USER_SENTINEL", "ANSWER_SENTINEL"]);
  });

  it("does not append status when a completion callback resolves after teardown", async () => {
    await fixture();
    const entered = gate();
    const release = gate();
    config.onTurnComplete = async () => {
      entered.resolve();
      await release.promise;
      config.currentSession = () => ({
        key: "LATE_SESSION",
        name: "LATE_TITLE",
      });
      if (config.header) {
        config.header.subtitle = "LATE_TITLE";
      }
    };
    await command("USER_SENTINEL");
    await bounded(entered.promise);
    const before = lines();
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGINT", "SIGINT");
    release.resolve();
    expect(await bounded(Promise.resolve(run))).toBe(0);
    run = undefined;
    expect(lines()).toEqual(before);
  });
});
