import { describe, expect, it, vi } from "vitest";
import { FooterStatusBar } from "./agent";

// biome-ignore lint/suspicious/noControlCharactersInRegex: test helper strips ANSI emitted by the footer
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

describe("FooterStatusBar", () => {
  it("does not tick while idle and stops after running entries clear", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const footer = new FooterStatusBar({ requestRender });

    vi.advanceTimersByTime(240);
    expect(requestRender).not.toHaveBeenCalled();

    footer.setEntries([{ message: "Running", state: "running" }]);
    requestRender.mockClear();
    vi.advanceTimersByTime(240);
    expect(requestRender).toHaveBeenCalled();

    footer.setEntries([]);
    requestRender.mockClear();
    vi.advanceTimersByTime(240);
    expect(requestRender).not.toHaveBeenCalled();
    footer.stop();
    vi.useRealTimers();
  });

  it("keeps right-side status within the render width", () => {
    const footer = new FooterStatusBar({ requestRender: vi.fn() });
    footer.setRightText("this status is far too long");

    const [line = ""] = footer.render(12);
    expect(line.replace(ANSI_PATTERN, "").length).toBeLessThanOrEqual(12);
    footer.stop();
  });

  it("honors one- and two-column render widths", () => {
    const footer = new FooterStatusBar({ requestRender: vi.fn() });
    footer.setRightText("x");

    for (const width of [1, 2]) {
      const [line = ""] = footer.render(width);
      expect(line.replace(ANSI_PATTERN, "").length).toBeLessThanOrEqual(width);
    }
    footer.stop();
  });

  it("shares narrow widths between running and right-side status", () => {
    const footer = new FooterStatusBar({ requestRender: vi.fn() });
    footer.setEntries([{ message: "Running a long tool", state: "running" }]);
    footer.setRightText("tokens: 123456789");

    const [line = ""] = footer.render(18);
    expect(line.replace(ANSI_PATTERN, "").length).toBeLessThanOrEqual(18);
    footer.stop();
  });
});
