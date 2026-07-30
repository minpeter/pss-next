import { describe, expect, it } from "vitest";
import {
  formatSessionResumeHint,
  terminalExitCursorSequence,
} from "./terminal-exit";

describe("terminal exit", () => {
  it("erases the composer rows below the transcript", () => {
    expect(terminalExitCursorSequence(4)).toBe("\x1b[4A\r\x1b[J");
  });

  it("only erases in place when no composer rows were rendered", () => {
    expect(terminalExitCursorSequence(0)).toBe("\r\x1b[J");
  });

  it("prints a directly usable resume command", () => {
    expect(formatSessionResumeHint("cwd:/repo/demo#abc")).toBe(
      "To resume this session: pss --session cwd:/repo/demo#abc"
    );
  });

  it("shell-quotes unusual session keys", () => {
    expect(formatSessionResumeHint("session 'with space'")).toBe(
      `To resume this session: pss --session 'session '"'"'with space'"'"''`
    );
  });
});
