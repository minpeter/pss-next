import {
  getOsc8LinkAtColumn,
  Markdown,
  type MarkdownTheme,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { composeAssistantRenderers } from "./assistant-renderer";
import { SnapshotMarkdown, SnapshotText } from "./snapshot-views";
import { AssistantStreamView } from "./stream-views";
import { BaseToolCallView } from "./tool-call-view";
import { ColdSnapshot, TranscriptOwner } from "./transcript-owner";

const identity = (text: string) => text;
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
const paragraph = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
const plain = (rows: string[]) =>
  rows.map(stripTerminalSequences).map((row) => row.trimEnd());

describe("COLD resize layout", () => {
  it.each([
    paragraph,
    `${paragraph}\nHARD_BREAK\n\nAFTER_BLANK`,
    "| Name | Description |\n| --- | --- |\n| FIRST | many words in the first table cell that wrap narrowly |\n| SECOND | second cell has a longer description too |",
    `\`\`\`ts\nconst value = '${paragraph}';\n  secondLine();\n\`\`\``,
    `漢字é🙂 ${paragraph} 漢字é🙂`,
  ])("re-lays out completed Markdown from the sealed source: %s", (source) => {
    let width = 24;
    const owner = new TranscriptOwner(() => width);
    const lease = owner.acquire(() => new AssistantStreamView(theme), {
      leadingSpacer: false,
      dispose: (view) => view.dispose(),
    });
    lease.view.appendText(source);
    lease.view.completeText();
    owner.finish(lease);
    const original = owner.render(width);
    for (width of [100, 48, 120, 24]) {
      expect(owner.render(width)).toEqual(
        new Markdown(source, 1, 0, theme).render(width)
      );
    }
    expect(owner.render(width)).toEqual(original);
  });

  it("selects the pretty tool tail once, then joins its soft wraps without revealing discarded text", () => {
    let width = 24;
    const owner = new TranscriptOwner(() => width);
    const lease = owner.acquire(
      () => new BaseToolCallView("call", "test", theme),
      { leadingSpacer: false, dispose: (view) => view.dispose() }
    );
    lease.view.setPrettyBlock("HEADER", `DISCARDED\n${paragraph}`, {
      useBackground: false,
    });
    owner.finish(lease);
    const original = plain(owner.render(width));
    const selected = original.slice(2).join(" ").replace(/\s+/g, " ").trim();
    width = 120;
    const wide = plain(owner.render(width));
    expect(wide.length).toBeLessThan(original.length);
    expect(wide.slice(2).join(" ").replace(/\s+/g, " ").trim()).toBe(selected);
    expect(wide.join("\n")).not.toContain("DISCARDED");
    width = 24;
    expect(plain(owner.render(width))).toEqual(original);
  });

  it.each([
    `${paragraph}\n\nLAST\nLINE`,
    "漢字é🙂".repeat(120),
    `\x1b[31m${"repeat repeat ".repeat(100)}\nLAST\x1b[0m`,
    Array.from({ length: 20 }, (_, i) => `LINE_${i}`).join("\n"),
  ])("keeps only selected tool glyphs and inherited ANSI: %s", (source) => {
    const owner = new TranscriptOwner(() => 24);
    const lease = owner.acquire(
      () => new BaseToolCallView("call", "test", theme),
      { leadingSpacer: false, dispose: (view) => view.dispose() }
    );
    lease.view.setPrettyBlock("HEADER", source, {
      allowAnsi: true,
      useBackground: false,
    });
    owner.finish();
    const snapshot = owner.children[0];
    const glyphs = (width: number) =>
      plain(snapshot.render(width)).join("").replace(/\s/g, "");
    for (const width of [12, 48, 120, 24]) {
      expect(glyphs(width)).toBe(glyphs(24));
    }
  });

  it.each([paragraph, `\`\`\`ts\n${paragraph}\n\`\`\``])(
    "selects reasoning and raw tool bodies only once: %s",
    (source) => {
      const owner = new TranscriptOwner(() => 24);
      const lease = owner.acquire(() => new AssistantStreamView(theme), {
        leadingSpacer: false,
        dispose: (view) => view.dispose(),
      });
      lease.view.appendReasoning(source);
      owner.finish();
      const snapshot = owner.children[0];
      const glyphs = (width: number) =>
        plain(snapshot.render(width)).join("").replace(/\s/g, "");
      for (const width of [12, 48, 120, 24]) {
        expect(glyphs(width)).toBe(glyphs(24));
      }
    }
  );

  it.each([
    "| Name | Description |\n| --- | --- |\n| FIRST | many words in the first table cell that wrap narrowly |\n| SECOND | second cell has a longer description too |",
    `- ${paragraph}\n- ${paragraph.replaceAll("word", "item")}`,
    `> ${paragraph}`,
  ])(
    "preserves selected structured Markdown tokens on resize: %s",
    (source) => {
      const owner = new TranscriptOwner(() => 24);
      const lease = owner.acquire(() => new AssistantStreamView(theme), {
        leadingSpacer: false,
        dispose: (view) => view.dispose(),
      });
      lease.view.appendReasoning(source);
      owner.finish();
      const snapshot = owner.children[0];
      const tokens = (width: number) =>
        plain(snapshot.render(width))
          .join("")
          .match(/[A-Za-z0-9]/g)
          ?.sort();
      for (const width of [48, 120, 24]) {
        expect(tokens(width)).toEqual(tokens(24));
      }
    }
  );

  it("uses a transparent fallback's captured transformed source", () => {
    const renderer = composeAssistantRenderers([
      (context) => {
        const delegate = context.delegate;
        if (!delegate) {
          throw new Error("Expected a composed delegate");
        }
        let inner: ReturnType<typeof delegate>;
        return {
          setText: (text) => {
            inner = delegate(`PREFIX ${text}`);
          },
          render: (width) => inner.render(width),
          invalidate: () => inner.invalidate(),
        };
      },
    ]);
    const view = new AssistantStreamView(theme, {
      assistantRenderer: renderer,
    });
    view.appendText(paragraph);
    view.completeText();
    const snapshot = ColdSnapshot.capture(view, 24);
    view.dispose();
    expect(snapshot.render(120)).toEqual(
      new Markdown(`PREFIX ${paragraph}`, 1, 0, theme).render(120)
    );
  });

  it("copies custom snapshot data and never re-enters an abort-ignoring renderer", () => {
    const data = {
      kind: "text" as const,
      text: paragraph,
      paddingX: 1,
      paddingY: 0,
    };
    const render = vi.fn((width: number) =>
      new Text(data.text, 1, 0).render(width)
    );
    const capture = vi.fn(() => data);
    const owner = new TranscriptOwner(() => 24);
    const lease = owner.acquire(
      (permission) => {
        permission.signal.addEventListener("abort", () => {
          data.text = "LATE";
        });
        return { render, invalidate: vi.fn(), captureCold: capture };
      },
      { leadingSpacer: false }
    );
    owner.finish(lease);
    const calls = render.mock.calls.length;
    for (const width of [100, 48, 120, 24]) {
      expect(owner.render(width)).toEqual(
        new Text(paragraph, 1, 0).render(width)
      );
    }
    expect(capture).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(calls);
  });

  it("retains selected ANSI and OSC8 styles across widths", () => {
    const view = new BaseToolCallView("call", "test", theme);
    view.setPrettyBlock(
      "HEADER",
      `\x1b]8;;https://fixture.invalid\x07\x1b[31m${paragraph.repeat(8)}\x1b[0m\x1b]8;;\x07`,
      { allowAnsi: true, useBackground: false }
    );
    const snapshot = ColdSnapshot.capture(view, 24);
    view.dispose();
    for (const width of [12, 48, 120, 24]) {
      const row = snapshot.render(width)[2];
      expect(getOsc8LinkAtColumn(row, 1)).toBe("https://fixture.invalid");
      expect(row).toContain("\x1b[31m");
    }
  });

  it("captures highlighting once and does not retain theme callbacks", () => {
    const highlightCode = vi.fn((code: string) =>
      code.split("\n").map((line) => `\x1b[31m${line}\x1b[0m`)
    );
    const source = `\`\`\`ts\n${paragraph}\n\`\`\``;
    const mutableTheme = { ...theme, highlightCode };
    const view = new SnapshotMarkdown(source, 1, 0, mutableTheme);
    const snapshot = ColdSnapshot.capture(view, 24);
    const calls = highlightCode.mock.calls.length;
    mutableTheme.codeBlock = () => "CHANGED_STYLE";
    for (const width of [48, 120, 24]) {
      expect(snapshot.render(width).join("")).toContain("\x1b[31m");
    }
    expect(highlightCode).toHaveBeenCalledTimes(calls);
  });

  it("preserves non-wrapper custom theme output as an explicit opaque layout", () => {
    const view = new SnapshotMarkdown("`lower_case`", 1, 0, {
      ...theme,
      code: (text) => text.toUpperCase(),
    });
    const snapshot = ColdSnapshot.capture(view, 24);
    const data = snapshot.captureCold();
    expect(data.kind).toBe("selected");
    if (data.kind !== "selected") {
      throw new Error("Expected original-width layout cache");
    }
    expect(data.content).toMatchObject({
      kind: "fixed",
      reason: "opaque-renderer",
    });
    expect(plain(snapshot.render(120)).join("")).toContain("LOWER_CASE");
  });

  it("keeps genuine blank lines and hard breaks in a sealed startup-like Text", () => {
    let width = 24;
    const owner = new TranscriptOwner(() => width);
    owner.addChild(new SnapshotText(`${paragraph}\nMODEL\n\nHELP`, 1, 0));
    width = 120;
    expect(owner.render(width)).toEqual(
      new Text(`${paragraph}\nMODEL\n\nHELP`, 1, 0).render(width)
    );
  });
});
