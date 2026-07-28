import {
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
} from "@earendil-works/pi-tui";

import type {
  AssistantRenderer,
  AssistantTextView,
} from "./assistant-renderer";
import { sanitizeTerminalText } from "./terminal-safety";

const ANSI_RESET = "\x1b[0m";
const LEADING_NEWLINES = /^\n+/;
const OUTER_NEWLINES = /^\n+|\n+$/g;
const THINKING_TEXT_STYLE = "\x1b[2m\x1b[3m\x1b[90m";

const styleThinkingText = (text: string): string =>
  `${THINKING_TEXT_STYLE}${text}${ANSI_RESET}`;

const ignoreRenderRequest = (): void => {
  // Tests and standalone consumers do not need an asynchronous redraw hook.
};

const ignoreNotification = (): void => {
  return;
};

const ignoreNotificationOnce = (): void => {
  return;
};

interface AssistantStreamSegment {
  content: string;
  type: "reasoning" | "text";
  view: AssistantTextView;
}

interface AssistantStreamViewOptions {
  readonly assistantRenderer?: AssistantRenderer;
  readonly notify?: (message: string) => void;
  readonly notifyOnce?: (key: string, message: string) => void;
  readonly requestRender?: () => void;
  readonly signal?: AbortSignal;
}

export class AssistantStreamView extends Container {
  private readonly assistantRenderer: AssistantRenderer | undefined;
  private readonly controller = new AbortController();
  private disposed = false;
  private readonly markdownTheme: MarkdownTheme;
  private readonly notify: (message: string) => void;
  private readonly notifyOnce: (key: string, message: string) => void;
  private readonly requestRender: () => void;
  private readonly segments: AssistantStreamSegment[] = [];
  private readonly signal: AbortSignal;

  constructor(
    markdownTheme: MarkdownTheme,
    options: AssistantStreamViewOptions = {}
  ) {
    super();
    this.assistantRenderer = options.assistantRenderer;
    this.markdownTheme = markdownTheme;
    this.signal =
      options.signal === undefined
        ? this.controller.signal
        : AbortSignal.any([this.controller.signal, options.signal]);
    const notify = options.notify ?? ignoreNotification;
    const notifyOnce = options.notifyOnce ?? ignoreNotificationOnce;
    const requestRender = options.requestRender ?? ignoreRenderRequest;
    this.notify = (message) => {
      if (!this.signal.aborted) {
        notify(message);
      }
    };
    this.notifyOnce = (key, message) => {
      if (!this.signal.aborted) {
        notifyOnce(key, message);
      }
    };
    this.requestRender = () => {
      if (!this.signal.aborted) {
        requestRender();
      }
    };
    this.refresh();
  }

  appendReasoning(delta: string): void {
    this.appendSegment("reasoning", delta);
  }

  appendText(delta: string): void {
    this.appendSegment("text", delta);
  }

  private appendSegment(
    type: AssistantStreamSegment["type"],
    delta: string
  ): void {
    const sanitized = sanitizeTerminalText(delta);
    if (sanitized.length === 0) {
      return;
    }

    const lastSegment = this.segments.at(-1);
    if (lastSegment && lastSegment.type === type) {
      lastSegment.content += sanitized;
    } else {
      const view =
        type === "text"
          ? (this.assistantRenderer?.({
              markdownTheme: this.markdownTheme,
              notify: this.notify,
              notifyOnce: this.notifyOnce,
              requestRender: this.requestRender,
              signal: this.signal,
            }) ?? new Markdown("", 1, 0, this.markdownTheme))
          : new Markdown("", 1, 0, this.markdownTheme, {
              color: styleThinkingText,
              italic: true,
            });
      this.segments.push({
        type,
        content: sanitized,
        view,
      });
    }

    this.refresh();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.controller.abort();
    for (const { view } of this.segments) {
      view.dispose?.();
    }
    this.segments.length = 0;
    this.clear();
  }

  private refresh(): void {
    this.clear();

    const visibleSegments = this.segments
      .map((segment) => {
        const normalizedContent =
          segment.type === "reasoning"
            ? segment.content.replace(LEADING_NEWLINES, "").trimEnd()
            : segment.content.replace(OUTER_NEWLINES, "");

        return {
          ...segment,
          content: normalizedContent,
        };
      })
      .filter((segment) => segment.content.trim().length > 0);

    if (visibleSegments.length === 0) {
      return;
    }

    for (let index = 0; index < visibleSegments.length; index += 1) {
      const segment = visibleSegments[index];
      const text = segment.content;

      segment.view.setText(text);
      this.addChild(segment.view);

      if (index < visibleSegments.length - 1) {
        this.addChild(new Spacer(1));
      }
    }
  }
}
