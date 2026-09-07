import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShellExecuteTool } from "../../workspace-tools/shell-execute";
import { stripTerminalEscapes } from "../terminal-safety";
import { BaseToolCallView } from "../tool-call-view";
import { createToolRenderers } from "./tool-renderers";

const theme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const cases = [
  { command: "printf 'file.html\\n'", body: "file.html\n", exit: "0" },
  { command: "true", body: "", exit: "0" },
  {
    command: "printf 'warning\\n' >&2",
    body: "\nstderr:\nwarning\n",
    exit: "0",
  },
  {
    command: "printf 'out\\n'; printf 'err\\n' >&2; exit 1",
    body: "out\n\nstderr:\nerr\n",
    exit: "1",
  },
  { command: "exit 1", body: "", exit: "1" },
  {
    command: "printf 'before\\nstderr:\\nafter\\n'",
    body: "before\nstderr:\nafter\n",
    exit: "0",
  },
  { command: "printf 'stderr:'", body: "stderr:", exit: "0" },
  { command: "printf ' \\t\\n' >&2", body: "", exit: "0" },
  { command: "printf ' \\t\\n'", body: " \t\n", exit: "0" },
  {
    command: "printf 'file.html\\n'; printf ' \\t\\n' >&2",
    body: "file.html\n",
    exit: "0",
  },
  { command: "kill -TERM $$", body: "", exit: "null" },
] as const;

const ERROR_BG = "\x1b[48;5;88m";

describe("shell result display from real commands", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pss-shell-display-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it.each(cases)(
    "renders $command without inventing stderr",
    async (testCase) => {
      // Given an actual shell executor and the production tool view.
      const execute = createShellExecuteTool(workspace).execute;
      if (!execute) {
        throw new Error("Expected an executable shell tool");
      }
      const input = { command: testCase.command };
      const view = new BaseToolCallView(
        "shell-test",
        "shell_execute",
        theme,
        undefined,
        false,
        createToolRenderers()
      );
      const block = vi.spyOn(view, "setPrettyBlock");
      view.setFinalInput(input);

      try {
        // When the real command completes and its result reaches the view.
        const output = await execute(input, {
          context: {},
          messages: [],
          toolCallId: "shell-test",
        });
        if (typeof output !== "string") {
          throw new TypeError("Expected a string shell result");
        }
        view.setOutput(output);

        // Then raw metadata stays truthful and the pretty body has no empty section.
        const lines = output.split("\n");
        expect(lines[1]).toBe(`exit_code: ${testCase.exit}`);
        expect(lines[2]).toBe(
          `signal: ${testCase.exit === "null" ? "SIGTERM" : "none"}`
        );
        expect(lines[3]).toBe("stdout:");
        expect(lines.slice(4).join("\n")).toBe(testCase.body);
        expect(output.startsWith("ERROR")).toBe(testCase.exit !== "0");
        const body = testCase.body.trim() ? testCase.body : "(No output)";
        const suffix = testCase.exit === "0" ? "" : `  (exit ${testCase.exit})`;
        expect(block).toHaveBeenLastCalledWith(
          `**bash** \`${testCase.command}\`${suffix}`,
          body,
          { isError: testCase.exit !== "0" }
        );
        const rendered = view.render(120).join("\n");
        expect(rendered.includes(ERROR_BG)).toBe(testCase.exit !== "0");
        const visible = stripTerminalEscapes(rendered)
          .split("\n")
          .map((line) => line.trim())
          .join("\n");
        expect(visible).toContain(body.trim());
      } finally {
        view.dispose();
      }
    }
  );
});
