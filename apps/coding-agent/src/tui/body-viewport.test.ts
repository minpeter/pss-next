import {
  getOsc8LinkAtColumn,
  type MarkdownTheme,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AssistantStreamView } from "./stream-views";
import { BaseToolCallView } from "./tool-call-view";

const identity = (text: string): string => text;
const theme: MarkdownTheme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
};
const source = (count: number): string =>
  Array.from(
    { length: count },
    (_, i) => `ROW_${String(i + 1).padStart(2, "0")}`
  ).join("\n");
const plain = (rows: string[]): string[] => rows.map(stripTerminalSequences);

describe("auto-following body rows", () => {
  it.each([0, 1, 8, 9, 30])(
    "bounds %i pretty rows and follows the tail",
    (count) => {
      const view = new BaseToolCallView("call", "custom", theme);
      view.setPrettyBlock("HEADER", source(count));
      const rows = plain(view.render(100));
      expect(rows).toHaveLength(count === 0 ? 1 : 2 + Math.min(8, count));
      if (count > 0) {
        expect(rows.at(-1)).toContain(`ROW_${String(count).padStart(2, "0")}`);
      }
      if (count > 8) {
        expect(rows.join("\n")).not.toContain("ROW_01");
      }
      view.dispose();
    }
  );

  it.each([9, 30])("bounds %i reasoning rows", (count) => {
    const view = new AssistantStreamView(theme);
    view.appendReasoning(source(count));
    const rows = plain(view.render(100));
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows.join("\n")).toContain(`ROW_${String(count).padStart(2, "0")}`);
    expect(rows.join("\n")).not.toContain("ROW_01");
    view.dispose();
  });

  it("follows text after reasoning without accumulating segment budgets", () => {
    const view = new AssistantStreamView(theme);
    view.appendReasoning(source(30));
    view.appendText(source(30).replaceAll("ROW", "TEXT"));
    expect(view.render(48)).toHaveLength(8);
    expect(plain(view.render(48)).join("\n")).toContain("TEXT_30");
    expect(plain(view.render(48)).join("\n")).not.toContain("ROW_");
    expect(view).toMatchObject({
      segments: [
        { content: source(30) },
        { content: source(30).replaceAll("ROW", "TEXT") },
      ],
    });
    view.dispose();
  });

  it("shows the latest suffix beyond the ninth wrapped input row", () => {
    const view = new BaseToolCallView("call", "custom", theme);
    view.setPrettyBlock("HEADER", `${"x".repeat(48 * 30)}LATEST_TAIL`);
    expect(plain(view.render(48)).join("")).toContain("LATEST_TAIL");
    view.dispose();
  });

  it("wraps a single long line before following, including after resize", () => {
    const view = new BaseToolCallView("call", "custom", theme);
    const body = `${"漢字😀é".repeat(150)}TAIL`;
    view.setPrettyBlock("HEADER", body);
    for (const width of [100, 48, 12, 100]) {
      const rows = view.render(width);
      expect(rows).toHaveLength(10);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(plain(rows).join("")).toContain("TAIL");
    }
    expect(view).toMatchObject({ readBody: { text: body } });
    view.dispose();
  });

  it.each([false, true])(
    "keeps streamed input and final result/error bounded (raw=%s)",
    async (raw) => {
      const view = new BaseToolCallView(
        "call",
        "write_file",
        theme,
        undefined,
        raw
      );
      const input = { path: "sample", content: source(30) };
      const json = JSON.stringify(input);
      await view.appendInputChunk(json);
      expect(view.render(48).length).toBeLessThanOrEqual(raw ? 12 : 10);
      view.setFinalInput(input);
      view.setOutput(source(30));
      expect(view.render(48).length).toBeLessThanOrEqual(24);
      expect(plain(view.render(48)).join("\n")).toContain("ROW_30");
      view.setError(source(30).replaceAll("ROW", "ERR"));
      expect(view.render(48).length).toBeLessThanOrEqual(36);
      expect(plain(view.render(48)).join("\n")).toContain("ERR_30");
      expect(view).toMatchObject({
        inputBuffer: json,
        finalInput: input,
        output: source(30),
      });
      expect(view.getError()).toBe(source(30).replaceAll("ROW", "ERR"));
      view.dispose();
    }
  );

  it("retains ANSI styling from rows above the viewport", () => {
    const view = new BaseToolCallView("call", "custom", theme);
    view.setPrettyBlock("HEADER", `\x1b[31m${source(30)}\x1b[0m`, {
      allowAnsi: true,
      useBackground: false,
    });
    const body = view.render(100).slice(2);
    expect(body).toHaveLength(8);
    expect(body[0]).toContain("\x1b[31m");
    expect(plain(body)[0]).toContain("ROW_23");
    view.dispose();
  });

  it.each([
    "\x1b_Ga=T,f=100;AAAA\x1b\\",
    "\x1b]1337;File=inline=1:AAAA\x07",
    "\x1bPqAAAA\x1b\\",
  ])("preserves atomic graphical renderer output %s", (transmission) => {
    const rows = [transmission, ...Array.from({ length: 12 }, () => "")];
    const view = new AssistantStreamView(theme, {
      assistantRenderer: () => ({
        invalidate: () => undefined,
        setText: () => undefined,
        render: () => rows,
      }),
    });
    view.appendText("image source");
    expect(view.render(48)).toEqual(rows);
    view.dispose();
  });

  it("preserves inherited OSC8 links in the tail", () => {
    const view = new BaseToolCallView("call", "custom", theme);
    view.setPrettyBlock(
      "HEADER",
      `\x1b]8;;https://example.test\x07${source(30)}\x1b]8;;\x07`,
      { allowAnsi: true, useBackground: false }
    );
    expect(getOsc8LinkAtColumn(view.render(48)[2] ?? "", 1)).toBe(
      "https://example.test"
    );
    view.dispose();
  });

  it("keeps simultaneous tools independent and preserves input on abort", async () => {
    const first = new BaseToolCallView("one", "write_file", theme);
    const second = new BaseToolCallView("two", "write_file", theme);
    const firstInput = JSON.stringify({ content: source(30) });
    await first.appendInputChunk(firstInput);
    await second.appendInputChunk(
      JSON.stringify({ content: source(9).replaceAll("ROW", "OTHER") })
    );
    first.dispose();
    expect(first).toMatchObject({ inputBuffer: firstInput, output: undefined });
    expect(first.render(48)).toHaveLength(10);
    expect(plain(first.render(48)).join("\n")).toContain("ROW_30");
    expect(plain(second.render(48)).join("\n")).toContain("OTHER_09");
    second.dispose();
  });

  it("bounds custom Markdown overrides and preserves code fences in source", () => {
    const markdown = `\`\`\`ts\n${source(30)}\n\`\`\``;
    const view = new BaseToolCallView(
      "call",
      "custom",
      theme,
      undefined,
      false,
      { custom: (target) => target.setRenderedOverride(markdown) }
    );
    view.setOutput("result");
    expect(view.render(48)).toHaveLength(8);
    expect(plain(view.render(48)).join("\n")).toContain("ROW_30");
    expect(view).toMatchObject({ renderedOverride: markdown });
    view.dispose();
  });
});
