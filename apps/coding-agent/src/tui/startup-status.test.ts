import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodingAgentCli } from "../cli";
import { showStartupStatus } from "./startup-status";

const SPINNER_PATTERN = /[\u2800-\u28ff]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control sequences for width checks
const ANSI_PATTERN = /\x1b\[[0-9;]*[mK]/g;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pre-mount startup status", () => {
  it("covers CLI extension discovery before startTui exists", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let entered!: () => void;
    let release!: () => void;
    const loading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = runCodingAgentCli({
      argv: [],
      loadExtensions: async () => {
        entered();
        await pending;
        return { extensions: [], notices: [] };
      },
      start: async () => 0,
    });
    try {
      await loading;
      const before = String(write.mock.calls.at(-1)?.[0]);
      vi.advanceTimersByTime(80);
      const after = String(write.mock.calls.at(-1)?.[0]);
      expect(before.match(SPINNER_PATTERN)?.[0]).toBeDefined();
      expect(after.match(SPINNER_PATTERN)?.[0]).toBeDefined();
      expect(after.match(SPINNER_PATTERN)?.[0]).not.toBe(
        before.match(SPINNER_PATTERN)?.[0]
      );
    } finally {
      release();
      await run;
      expect(vi.getTimerCount()).toBe(0);
      if (tty) {
        Object.defineProperty(process.stdout, "isTTY", tty);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });
  it.each([1, 2, 80])(
    "animates at %i columns and clears exactly once before mount",
    (columns) => {
      vi.useFakeTimers();
      const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      const width = Object.getOwnPropertyDescriptor(process.stdout, "columns");
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: columns,
      });
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        const stop = showStartupStatus();
        const before = String(write.mock.calls.at(-1)?.[0]);
        vi.advanceTimersByTime(80);
        const after = String(write.mock.calls.at(-1)?.[0]);
        expect(before.match(SPINNER_PATTERN)?.[0]).toBeDefined();
        expect(after.match(SPINNER_PATTERN)?.[0]).toBeDefined();
        expect(after.match(SPINNER_PATTERN)?.[0]).not.toBe(
          before.match(SPINNER_PATTERN)?.[0]
        );
        expect(
          after.replace(ANSI_PATTERN, "").replace("\r", "").length
        ).toBeLessThanOrEqual(columns);
        stop();
        const writes = write.mock.calls.length;
        stop();
        vi.advanceTimersByTime(80);
        expect(write.mock.calls).toHaveLength(writes);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        if (tty) {
          Object.defineProperty(process.stdout, "isTTY", tty);
        } else {
          Reflect.deleteProperty(process.stdout, "isTTY");
        }
        if (width) {
          Object.defineProperty(process.stdout, "columns", width);
        } else {
          Reflect.deleteProperty(process.stdout, "columns");
        }
      }
    }
  );
});
