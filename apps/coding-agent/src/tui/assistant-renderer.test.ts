import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  type AssistantRenderer,
  composeAssistantRenderers,
  createAssistantRendererNotifications,
} from "./assistant-renderer";

describe("assistant renderer notifications", () => {
  it("deduplicates keys for the whole TUI session", () => {
    const messages: string[] = [];
    const notifications = createAssistantRendererNotifications((message) => {
      messages.push(message);
    });

    notifications.notifyOnce("latex:missing", "first");
    notifications.notifyOnce("latex:missing", "duplicate");
    notifications.notifyOnce("other", "second");

    expect(messages).toEqual(["first", "second"]);
  });
});

const markdownTheme: MarkdownTheme = {
  bold: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  heading: (text) => text,
  hr: (text) => text,
  italic: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  listBullet: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const wrapRenderer =
  (name: string): AssistantRenderer =>
  (context) => {
    let text = "";
    return {
      invalidate() {
        return;
      },
      render(width: number) {
        const inner = context.delegate?.(`${name}(${text})`);
        return inner === undefined ? [`${name}(${text})`] : inner.render(width);
      },
      setText(value: string) {
        text = value;
      },
    };
  };

describe("composeAssistantRenderers", () => {
  it("returns undefined for an empty chain", () => {
    expect(composeAssistantRenderers([])).toBeUndefined();
  });

  it("delegates from the last registered renderer down to plain Markdown", () => {
    const composed = composeAssistantRenderers([
      wrapRenderer("inner"),
      wrapRenderer("outer"),
    ]);
    const view = composed?.({
      markdownTheme,
      notify: () => undefined,
      notifyOnce: () => undefined,
      requestRender: () => undefined,
      signal: new AbortController().signal,
    });
    view?.setText("hello");
    // "outer" runs first on the raw text, then the inner renderer wraps it.
    expect(view?.render(80).join("\n")).toContain("inner(outer(hello))");
  });

  it("gives every fallback renderer a delegate", () => {
    const composed = composeAssistantRenderers([wrapRenderer("only")]);
    const view = composed?.({
      markdownTheme,
      notify: () => undefined,
      notifyOnce: () => undefined,
      requestRender: () => undefined,
      signal: new AbortController().signal,
    });
    view?.setText("hello");
    expect(view?.render(80).join("\n")).toContain("only(hello)");
  });

  it("invalidates outer views when an inner renderer requests a redraw", () => {
    let innerRequestRender: (() => void) | undefined;
    let innerVersion = 0;
    const inner: AssistantRenderer = (context) => {
      innerRequestRender = context.requestRender;
      return {
        invalidate() {
          return;
        },
        render() {
          return [`v${innerVersion}`];
        },
        setText() {
          return;
        },
      };
    };
    let outerInvalidations = 0;
    const outer: AssistantRenderer = (context) => {
      let text = "";
      return {
        invalidate() {
          outerInvalidations += 1;
        },
        render(width: number) {
          const delegated = context.delegate?.(text);
          return delegated === undefined ? [] : delegated.render(width);
        },
        setText(value: string) {
          text = value;
        },
      };
    };
    let tuiRedraws = 0;
    const composed = composeAssistantRenderers([inner, outer]);
    const view = composed?.({
      markdownTheme,
      notify: () => undefined,
      notifyOnce: () => undefined,
      requestRender: () => {
        tuiRedraws += 1;
      },
      signal: new AbortController().signal,
    });
    view?.setText("x");
    expect(view?.render(80)).toEqual(["v0"]);

    innerVersion = 1;
    innerRequestRender?.();

    expect(outerInvalidations).toBe(1);
    expect(tuiRedraws).toBe(1);
    expect(view?.render(80)).toEqual(["v1"]);
  });
});
