import { describe, expect, it, vi } from "vitest";
import { FooterStatusBar } from "./agent";

// biome-ignore lint/suspicious/noControlCharactersInRegex: test helper strips ANSI emitted by the footer
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const SPINNER_PATTERN = /[\u2800-\u28ff]/u;

describe("FooterStatusBar", () => {
  it("reserves one blank row while idle so the editor cannot jump", () => {
    const footer = new FooterStatusBar({ requestRender: vi.fn() });

    const lines = footer.render(12);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.replace(ANSI_PATTERN, "")).toBe(" ".repeat(12));
    footer.stop();
  });

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

  it.each([1, 2, 3, 8, 18, 80])(
    "keeps an animated glyph at width %i despite long right status",
    (width) => {
      vi.useFakeTimers();
      const footer = new FooterStatusBar({ requestRender: vi.fn() });
      try {
        footer.setForegroundMessage("A long operation label");
        footer.setRightText("Custom footer status ".repeat(30));
        const before = footer.render(width)[0]?.replace(ANSI_PATTERN, "") ?? "";
        vi.advanceTimersByTime(80);
        footer.setForegroundMessage("Another label");
        const after = footer.render(width)[0]?.replace(ANSI_PATTERN, "") ?? "";
        expect(before).toMatch(SPINNER_PATTERN);
        expect(after).toMatch(SPINNER_PATTERN);
        expect(after.match(SPINNER_PATTERN)?.[0]).not.toBe(
          before.match(SPINNER_PATTERN)?.[0]
        );
        expect(before.length).toBeLessThanOrEqual(width);
        expect(after.length).toBeLessThanOrEqual(width);
      } finally {
        footer.stop();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    }
  );

  it("shares narrow widths between running and right-side status", () => {
    const footer = new FooterStatusBar({ requestRender: vi.fn() });
    footer.setEntries([{ message: "Running a long tool", state: "running" }]);
    footer.setRightText("tokens: 123456789");

    const [line = ""] = footer.render(18);
    expect(line.replace(ANSI_PATTERN, "").length).toBeLessThanOrEqual(18);
    footer.stop();
  });
});
