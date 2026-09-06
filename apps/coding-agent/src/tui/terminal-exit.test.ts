import type { TuiMainScreenRenderState } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  formatSessionResumeHint,
  terminalExitCursorSequence,
} from "./terminal-exit";

const state = (
  rows: number,
  cursor: number,
  viewportTop = 0
): TuiMainScreenRenderState => ({
  previousLines: Array.from({ length: rows }, () => ""),
  previousWidth: 48,
  previousHeight: 10,
  hardwareCursorRow: cursor,
  cursorRow: rows - 1,
  maxLinesRendered: rows,
  previousViewportTop: viewportTop,
});

describe("terminal exit", () => {
  it("reclaims the top composer border from the actual editor cursor", () => {
    expect(terminalExitCursorSequence(state(12, 9), 4)).toBe("\x1b[1A\r\x1b[J");
  });

  it("uses the same relative geometry after a long transcript scrolls", () => {
    expect(terminalExitCursorSequence(state(102, 99, 92), 4)).toBe(
      "\x1b[1A\r\x1b[J"
    );
  });

  it("moves down if a non-editor focus left the cursor above the composer", () => {
    expect(terminalExitCursorSequence(state(12, 6), 4)).toBe("\x1b[2B\r\x1b[J");
  });

  it("does not move above the viewport for an oversized composer", () => {
    expect(terminalExitCursorSequence(state(20, 17, 10), 15)).toBe(
      "\x1b[7A\r\x1b[J"
    );
  });

  it("only erases in place when the cursor is already on the border", () => {
    expect(terminalExitCursorSequence(state(12, 8), 4)).toBe("\r\x1b[J");
  });

  it("prints a directly usable resume command", () => {
    expect(formatSessionResumeHint("cwd:/repo/demo#a64fc845")).toBe(
      "To resume this session: pss --session a64fc845"
    );
  });

  it("falls back to the whole key when it has no short id", () => {
    expect(formatSessionResumeHint("legacy-key")).toBe(
      "To resume this session: pss --session legacy-key"
    );
  });
});
