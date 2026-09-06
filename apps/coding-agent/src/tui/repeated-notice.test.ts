import {
  type Component,
  Container,
  type Terminal,
  Text,
  type TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalHarness = vi.hoisted(() => ({
  send: (_data: string): void => undefined,
  surface: undefined as TuiMainScreen | undefined,
}));
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();
  const noop = () => undefined;
  class TestTerminal implements Terminal {
    columns = 80;
    rows = 24;
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
    start(onInput: (data: string) => void) {
      terminalHarness.send = onInput;
    }
  }
  class TestScreen extends actual.TuiMainScreen {
    override start() {
      terminalHarness.surface = this;
      super.start();
    }
  }
  return {
    ...actual,
    ProcessTerminal: TestTerminal,
    TuiMainScreen: TestScreen,
  };
});

import type { CodingAgentExtensionUi } from "../extensions/types";
import { createAgentTUI } from "./agent";
import { createModelCommand } from "./model-command";
import { createRepeatedNotice } from "./repeated-notice";
import { TuiSessionMachine } from "./session-state";
import { sanitizeTerminalText } from "./terminal-safety";
import { TranscriptOwner } from "./transcript-owner";

const EMPTY_NOTICE = "Please enter a message.";
const NOTICE_PULSE_MS = 140;
const GRAY_NOTICE = `\x1b[38;5;245m${EMPTY_NOTICE}\x1b[0m`;
const PULSED_NOTICE = `\x1b[47m\x1b[30m${EMPTY_NOTICE}\x1b[0m`;

const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const idleGate = () => {
  const idle = gate();
  const original = TuiSessionMachine.prototype.awaitInput;
  const spy = vi
    .spyOn(TuiSessionMachine.prototype, "awaitInput")
    .mockImplementation(function (this: TuiSessionMachine, resolve) {
      original.call(this, resolve);
      spy.mockRestore();
      idle.resolve();
    });
  return idle.promise;
};

const input = (value: string) => {
  for (const char of value) {
    terminalHarness.send(char);
  }
};

/**
 * Every mounted leaf row, in visual order. `Text` renders with one column of
 * padding, so the styled cell is compared after trimming the pad — the ANSI
 * styling itself is asserted byte-for-byte.
 */
const rows = (): string[] => {
  const surface = terminalHarness.surface;
  if (!surface) {
    throw new Error("No mounted surface");
  }
  const collected: string[] = [];
  const walk = (component: Component): void => {
    if (component instanceof Container) {
      for (const child of component.children) {
        walk(child);
      }
      return;
    }
    collected.push(...component.render(80).map((line) => line.trim()));
  };
  walk(surface);
  return collected;
};

const noticeRows = (): string[] =>
  rows().filter((row) => row.includes(EMPTY_NOTICE));

const exit = async (run: Promise<void>) => {
  process.emit("SIGINT", "SIGINT");
  process.emit("SIGINT", "SIGINT");
  await run;
  expect(vi.getTimerCount()).toBe(0);
};

const thread = () => ({
  interrupt: vi.fn(),
  send: vi.fn(() => {
    throw new Error("Unexpected send");
  }),
  steer: vi.fn(() => {
    throw new Error("Unexpected steer");
  }),
});

/**
 * Submits an empty line and waits for the TUI to be back at the prompt, so
 * every assertion runs against a settled transcript instead of a race.
 */
const submitEmpty = async (): Promise<void> => {
  const settled = idleGate();
  input("\r");
  await settled;
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const controllerFixture = () => {
  const chatContainer = new TranscriptOwner(() => 80);
  const requestRender = vi.fn();
  const rows: Text[] = [];
  const controller = createRepeatedNotice({
    appendNotice: (message) => {
      if (!message) {
        return;
      }
      const normalText = `normal:${message}`;
      const lease = chatContainer.acquire(() => new Text(normalText), {
        leadingSpacer: false,
        settle: () => controller.settle(),
      });
      rows.push(lease.view);
      return { normalText, row: lease.view, isActive: () => lease.active };
    },
    normalStyle: (message) => `normal:${message}`,
    pulseStyle: (message) => `pulse:${message}`,
    requestRender,
  });
  const contents = () =>
    chatContainer.children
      .flatMap((row) => row.render(80))
      .map((line) => line.trim())
      .filter(Boolean);
  return { chatContainer, contents, controller, requestRender, rows };
};

describe("repeated notice pulse ownership", () => {
  it("replaces the current keyed notice and restores the latest text with one rearmed timer", () => {
    const { controller, contents } = controllerFixture();
    controller.show("MODEL_A", "model-change");
    for (const model of ["MODEL_B", "MODEL_C", "MODEL_D"]) {
      controller.show(model, "model-change");
      vi.advanceTimersByTime(NOTICE_PULSE_MS / 2);
      expect(contents()).toEqual([`pulse:${model}`]);
      expect(vi.getTimerCount()).toBe(1);
    }
    vi.advanceTimersByTime(NOTICE_PULSE_MS);
    expect(contents()).toEqual(["normal:MODEL_D"]);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it.each(["cold", "content", "different-key", "unkeyed"] as const)(
    "does not replace a keyed notice across %s",
    (boundary) => {
      const { controller, chatContainer, contents, rows } = controllerFixture();
      controller.show("MODEL_A", "model-change");
      controller.show("MODEL_B", "model-change");
      if (boundary === "cold") {
        chatContainer.finish();
      }
      if (boundary === "content") {
        chatContainer.addChild(new Text("CONTENT"));
      }
      if (boundary === "different-key") {
        controller.show("MODEL_B", "other");
      }
      if (boundary === "unkeyed") {
        controller.show("MODEL_B");
      }
      const before = contents();
      const oldSetter = vi.spyOn(rows[0], "setText");
      controller.show("MODEL_C", "model-change");
      expect(contents()).toEqual([...before, "normal:MODEL_C"]);
      expect(contents()[0]).toBe("normal:MODEL_B");
      expect(oldSetter).not.toHaveBeenCalled();
      controller.stop();
    }
  );

  it("never reuses a sealed notice even while it is still the transcript tail", () => {
    const { controller, chatContainer, contents, rows } = controllerFixture();
    controller.show("A");
    controller.show("A");
    chatContainer.finish();
    const cold = chatContainer.render(80);
    const oldSetter = vi.spyOn(rows[0], "setText");
    controller.settle();
    vi.advanceTimersByTime(NOTICE_PULSE_MS);
    expect(chatContainer.render(80)).toEqual(cold);
    controller.show("A");
    controller.show("A");
    expect(contents()).toEqual(["normal:A", "pulse:A"]);
    expect(oldSetter).not.toHaveBeenCalled();
    expect(chatContainer.children[0]?.render(80)).toEqual(cold);
    controller.settle();
    controller.stop();
  });

  it("restores the old row before a distinct notice replaces its pulse", () => {
    const { controller, contents, requestRender } = controllerFixture();
    controller.show("A");
    controller.show("A");
    expect(contents()).toEqual(["pulse:A"]);
    controller.show("B");
    expect(contents()).toEqual(["normal:A", "normal:B"]);
    controller.show("B");
    vi.advanceTimersByTime(NOTICE_PULSE_MS);
    expect(contents()).toEqual(["normal:A", "normal:B"]);
    controller.settle();
    controller.stop();
    const renders = requestRender.mock.calls.length;
    vi.runAllTimers();
    expect(requestRender).toHaveBeenCalledTimes(renders);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["user", "assistant", "tool"])(
    "settles before %s content and appends subsequent notices afresh",
    (kind) => {
      const { controller, chatContainer, contents } = controllerFixture();
      controller.show("A");
      controller.show("A");
      chatContainer.addChild(new Text(`${kind}:content`));
      controller.show("A");
      expect(contents()).toEqual(["normal:A", `${kind}:content`, "normal:A"]);
      controller.show("A");
      expect(contents()).toEqual(["normal:A", `${kind}:content`, "pulse:A"]);
      vi.advanceTimersByTime(NOTICE_PULSE_MS);
      expect(contents()).toEqual(["normal:A", `${kind}:content`, "normal:A"]);
      controller.stop();
    }
  );

  it("restores before reset drops a mounted pulse and starts fresh", () => {
    const { controller, contents } = controllerFixture();
    controller.show("A");
    controller.show("A");
    controller.reset();
    expect(contents()).toEqual(["normal:A"]);
    expect(vi.getTimerCount()).toBe(0);
    controller.show("A");
    expect(contents()).toEqual(["normal:A", "normal:A"]);
    controller.stop();
  });

  it.each(["reset", "timer"])(
    "does not repaint a cleared row on %s",
    (action) => {
      const { controller, chatContainer, requestRender, rows } =
        controllerFixture();
      controller.show("A");
      controller.show("A");
      const row = rows[0];
      const setText = vi.spyOn(row, "setText");
      chatContainer.reset("session-navigation");
      // The owner settles while still HOT, before revoking/resetting the epoch.
      expect(setText).toHaveBeenCalledExactlyOnceWith("normal:A");
      setText.mockClear();
      requestRender.mockClear();
      if (action === "reset") {
        controller.reset();
      }
      vi.advanceTimersByTime(NOTICE_PULSE_MS);
      expect(setText).not.toHaveBeenCalled();
      expect(requestRender).not.toHaveBeenCalled();
      controller.show("A");
      expect(chatContainer.children).toHaveLength(1);
      expect(rows.at(-1)).not.toBe(row);
      controller.stop();
    }
  );

  it("restores even when the replacement renders nothing", () => {
    const { controller, contents } = controllerFixture();
    controller.show("A");
    controller.show("A");
    controller.show("");
    expect(contents()).toEqual(["normal:A"]);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("stop cancels without repainting disposed UI, including later calls", () => {
    const { controller, chatContainer, requestRender, rows } =
      controllerFixture();
    controller.show("A");
    controller.show("A");
    const setText = vi.spyOn(rows[0], "setText");
    requestRender.mockClear();
    controller.stop();
    controller.show("A");
    controller.show("B");
    controller.reset();
    controller.settle();
    controller.stop();
    vi.runAllTimers();
    expect(setText).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
    expect(chatContainer.children).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.sequential("common system notices", () => {
  it("sanitizes keyed model updates before pulse and restores the newest normal text", async () => {
    let current = "MODEL_A";
    const hostile = "MODEL_B\x1b[2J\x1b]52;c;payload\x07";
    const model = createModelCommand({
      currentModelId: () => current,
      listModelIds: async () => ["MODEL_A", "MODEL_FIRST", hostile],
      switchModel: (id) => {
        current = id;
      },
    });
    let requested = "MODEL_FIRST";
    const command = {
      ...model,
      execute: () => model.execute({ args: [requested] }),
    };
    const ready = idleGate();
    const run = createAgentTUI({ thread: thread(), commands: [command] });
    const matching = () => rows().filter((row) => row.includes("MODEL_"));
    try {
      await ready;
      let settled = idleGate();
      input("/model\r");
      await settled;
      requested = hostile;
      settled = idleGate();
      input("/model\r");
      await settled;
      const result = await createModelCommand({
        currentModelId: () => "",
        listModelIds: async () => [hostile],
        switchModel: () => undefined,
      }).execute({ args: [hostile] });
      const cleaned = sanitizeTerminalText(result.message ?? "");
      expect(matching()).toEqual([`\x1b[47m\x1b[30m${cleaned}\x1b[0m`]);
      vi.advanceTimersByTime(NOTICE_PULSE_MS);
      expect(matching()).toEqual([`\x1b[38;5;245m${cleaned}\x1b[0m`]);
      expect(matching().join("")).not.toContain("\x1b[2J");
      expect(matching().join("")).not.toContain("\x1b]52");
    } finally {
      await exit(run);
    }
  });

  it("routes generic notifications through sanitized normal and pulse rendering", async () => {
    let ui!: CodingAgentExtensionUi;
    const idle = idleGate();
    const run = createAgentTUI({
      thread: thread(),
      onExtensionUiReady: (createUi) => {
        ui = createUi();
      },
    });
    const message = "Notice \x1b[2J\x1b]52;c;payload\x07\r!";
    const cleaned = sanitizeTerminalText(message);
    const matching = () => rows().filter((row) => row.includes("Notice "));
    try {
      await idle;
      ui.notify(message);
      expect(matching()).toEqual([`\x1b[38;5;245m${cleaned}\x1b[0m`]);
      ui.notify(message);
      expect(matching()).toEqual([`\x1b[47m\x1b[30m${cleaned}\x1b[0m`]);
      ui.notify("Different notice");
      expect(matching()).toEqual([`\x1b[38;5;245m${cleaned}\x1b[0m`]);
      ui.notify(message);
      expect(matching()).toEqual([
        `\x1b[38;5;245m${cleaned}\x1b[0m`,
        `\x1b[38;5;245m${cleaned}\x1b[0m`,
      ]);
    } finally {
      await exit(run);
    }
    const preserved = rows();
    ui.notify(message);
    expect(rows()).toEqual(preserved);
  });

  it.each([false, true])(
    "routes repeated command messages and caught system errors (throws=%s)",
    async (throws) => {
      const message = "Fixture \x1b[2J failure";
      const cleaned = sanitizeTerminalText(
        `${throws ? "Error: " : ""}${message}`
      );
      const idle = idleGate();
      const run = createAgentTUI({
        thread: thread(),
        commands: [
          {
            name: "note",
            description: "fixture",
            execute: () => {
              if (throws) {
                throw new Error(message);
              }
              return { success: true, message };
            },
          },
        ],
      });
      try {
        await idle;
        for (const expected of [
          `\x1b[38;5;245m${cleaned}\x1b[0m`,
          `\x1b[47m\x1b[30m${cleaned}\x1b[0m`,
        ]) {
          const settled = idleGate();
          input("/note\r");
          await settled;
          expect(rows().filter((row) => row.includes("Fixture "))).toEqual([
            expected,
          ]);
        }
        vi.advanceTimersByTime(NOTICE_PULSE_MS);
        expect(rows().filter((row) => row.includes("Fixture "))).toEqual([
          `\x1b[38;5;245m${cleaned}\x1b[0m`,
        ]);
      } finally {
        await exit(run);
      }
    }
  );

  it("appends after real user content interrupts an active empty-input pulse", async () => {
    const idle = idleGate();
    const run = createAgentTUI({
      thread: thread(),
      preprocessUserInput: async () => ({
        success: false,
        error: "Input rejected.",
      }),
    });
    try {
      await idle;
      await submitEmpty();
      await submitEmpty();
      const settled = idleGate();
      input("Visible user content\r");
      await settled;
      expect(noticeRows()).toEqual([GRAY_NOTICE]);
      await submitEmpty();
      expect(noticeRows()).toEqual([GRAY_NOTICE, GRAY_NOTICE]);
    } finally {
      await exit(run);
    }
  });
});

describe.sequential("repeated empty-input notice", () => {
  it("reuses one row and pulses black text on white instead of appending duplicates", async () => {
    const idle = idleGate();
    const run = createAgentTUI({ thread: thread() });
    try {
      await idle;

      await submitEmpty();
      expect(noticeRows()).toEqual([GRAY_NOTICE]);

      await submitEmpty();
      // Still exactly one row: the repeat reuses the visible notice.
      expect(noticeRows()).toEqual([PULSED_NOTICE]);

      vi.advanceTimersByTime(NOTICE_PULSE_MS);
      // Restored to the byte-identical normal style.
      expect(noticeRows()).toEqual([GRAY_NOTICE]);
    } finally {
      await exit(run);
    }
  });

  it("keeps one row and one pulse timer across rapid repeats", async () => {
    const idle = idleGate();
    const run = createAgentTUI({ thread: thread() });
    try {
      await idle;

      await submitEmpty();
      const baseTimers = vi.getTimerCount();

      for (let attempt = 0; attempt < 4; attempt++) {
        await submitEmpty();
        vi.advanceTimersByTime(NOTICE_PULSE_MS / 4);
        expect(noticeRows()).toEqual([PULSED_NOTICE]);
        // The repeat re-arms the same pulse rather than stacking timers.
        expect(vi.getTimerCount()).toBe(baseTimers + 1);
      }

      vi.advanceTimersByTime(NOTICE_PULSE_MS);
      expect(noticeRows()).toEqual([GRAY_NOTICE]);
      expect(vi.getTimerCount()).toBe(baseTimers);
    } finally {
      await exit(run);
    }
  });

  it("appends a fresh notice once other content lands after the tracked row", async () => {
    const idle = idleGate();
    const run = createAgentTUI({
      thread: thread(),
      commands: [
        {
          name: "note",
          description: "fixture",
          execute: () => ({ success: true, message: "Fixture ran." }),
        },
      ],
    });
    try {
      await idle;

      await submitEmpty();
      expect(noticeRows()).toEqual([GRAY_NOTICE]);

      const settled = idleGate();
      input("/note\r");
      await settled;
      expect(rows().some((row) => row.includes("Fixture ran."))).toBe(true);

      // The tracked notice is no longer the last row, so this is a genuinely
      // new notice and must not be suppressed.
      await submitEmpty();
      expect(noticeRows()).toEqual([GRAY_NOTICE, GRAY_NOTICE]);

      // The newest notice is the one that pulses.
      await submitEmpty();
      expect(noticeRows()).toEqual([GRAY_NOTICE, PULSED_NOTICE]);
      vi.advanceTimersByTime(NOTICE_PULSE_MS);
      expect(noticeRows()).toEqual([GRAY_NOTICE, GRAY_NOTICE]);
    } finally {
      await exit(run);
    }
  });

  it("leaves no pulse timer or stuck inversion when the TUI shuts down mid-pulse", async () => {
    const idle = idleGate();
    const run = createAgentTUI({ thread: thread() });
    await idle;

    await submitEmpty();
    await submitEmpty();
    expect(noticeRows()).toEqual([PULSED_NOTICE]);

    // exit() asserts the timer count is zero, i.e. the in-flight pulse timer
    // was cleared by disposal rather than left to fire after teardown.
    await exit(run);

    // The preserved final frame must not freeze the notice inverted.
    expect(noticeRows()).toEqual([GRAY_NOTICE]);
  });
});
