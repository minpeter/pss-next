import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AssistantStreamView } from "./stream-views";

const markdownTheme: MarkdownTheme = {
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

describe("AssistantStreamView terminal safety", () => {
  it("renders assistant and reasoning controls as visible text", () => {
    const view = new AssistantStreamView(markdownTheme);
    const payload = "hello \u001b]0;pwned\u0007";

    view.appendText(payload);
    view.appendReasoning(payload);

    const output = view.render(120).join("\n");
    expect(output.match(/\^\[\]0;pwned\^G/g)).toHaveLength(2);
    expect(output).not.toContain("\u001b]");
    expect(output).not.toContain("\u0007");
  });

  it("preserves leading indentation for Markdown code blocks", () => {
    const view = new AssistantStreamView({
      ...markdownTheme,
      codeBlock: (text) => `BLOCK:${text}`,
    });

    view.appendText("    const value = 1;");

    expect(view.render(120).join("\n")).toContain("BLOCK:");
  });
});
