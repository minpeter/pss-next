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
  it("uses an extension-provided assistant text renderer", () => {
    let renderedText = "";
    const view = new AssistantStreamView(markdownTheme, {
      assistantRenderer: () => ({
        invalidate() {
          return;
        },
        render() {
          return [`plugin:${renderedText}`];
        },
        setText(text: string) {
          renderedText = text;
        },
      }),
    });

    view.appendText("rendered by extension");

    expect(view.render(120)).toContain("plugin:rendered by extension");
  });

  it("passes resolved foreground to extension renderers", () => {
    let foregroundColor: string | undefined;
    const view = new AssistantStreamView(markdownTheme, {
      assistantRenderer: (context) => {
        foregroundColor = context.foregroundColor;
        return {
          invalidate() {
            return;
          },
          render() {
            return [];
          },
          setText() {
            return;
          },
        };
      },
      foregroundColor: "#e6edf3",
    });

    view.appendText("theme");

    expect(foregroundColor).toBe("#e6edf3");
  });

  it("passes lifecycle context and disposes extension views", () => {
    const controller = new AbortController();
    let disposed = false;
    let receivedSignal: AbortSignal | undefined;
    const view = new AssistantStreamView(markdownTheme, {
      assistantRenderer: ({ signal }) => {
        receivedSignal = signal;
        return {
          dispose() {
            disposed = true;
          },
          invalidate() {
            return;
          },
          render() {
            return [];
          },
          setText() {
            return;
          },
        };
      },
      signal: controller.signal,
    });
    view.appendText("lifecycle");

    expect(receivedSignal?.aborted).toBe(false);
    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);
    view.dispose();
    view.dispose();
    expect(disposed).toBe(true);
  });

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

  it("expands text without lifting the reasoning bound in a mixed view", () => {
    const view = new AssistantStreamView(markdownTheme);
    const source = (prefix: string) =>
      Array.from(
        { length: 20 },
        (_, i) => `${prefix}_${String(i).padStart(2, "0")}`
      ).join("\n");
    view.appendReasoning(source("THINK"));
    view.appendText(source("TEXT"));
    expect(view.render(48)).toHaveLength(8);
    view.completeText();
    const output = view.render(48).join("\n");
    expect(output.match(/THINK_\d+/g)).toHaveLength(8);
    expect(output.match(/TEXT_\d+/g)).toHaveLength(20);
    view.dispose();
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
