import { describe, expect, it } from "vitest";
import {
  formatSessionResumeHint,
  terminalExitCursorSequence,
} from "./terminal-exit";

describe("terminal exit", () => {
  it("moves from a padded viewport to the end of the transcript", () => {
    expect(terminalExitCursorSequence(24, 7)).toBe("\x1b[17A\r\x1b[J");
  });

  it("does not move above a transcript that fills the viewport", () => {
    expect(terminalExitCursorSequence(24, 24)).toBe("\r\x1b[J");
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
