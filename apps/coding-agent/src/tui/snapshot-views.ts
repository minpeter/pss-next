import {
  type DefaultTextStyle,
  Markdown,
  type MarkdownTheme,
  Text,
} from "@earendil-works/pi-tui";
import {
  type ColdContent,
  type ColdTheme,
  captureStyle,
  preservePresentation,
} from "./cold-content";

/** Host-owned views retain source explicitly; no reads of pi-tui private state. */
export class SnapshotText extends Text {
  #source: string;
  readonly #paddingX: number;
  readonly #paddingY: number;
  #background: ((text: string) => string) | undefined;

  constructor(
    text = "",
    paddingX = 1,
    paddingY = 1,
    background?: (text: string) => string
  ) {
    super(text, paddingX, paddingY, background);
    this.#source = text;
    this.#paddingX = paddingX;
    this.#paddingY = paddingY;
    this.#background = background;
  }
  override setText(text: string): void {
    this.#source = text;
    super.setText(text);
  }
  override setCustomBgFn(background?: (text: string) => string): void {
    this.#background = background;
    super.setCustomBgFn(background);
  }
  captureCold(width: number): ColdContent {
    return preservePresentation(
      {
        kind: "text",
        text: this.#source,
        paddingX: this.#paddingX,
        paddingY: this.#paddingY,
        background: this.#background && captureStyle(this.#background),
      },
      super.render(width),
      width
    );
  }
}

export class SnapshotMarkdown extends Markdown {
  #source: string;
  readonly #paddingX: number;
  readonly #paddingY: number;
  readonly #theme: MarkdownTheme;
  readonly #style: DefaultTextStyle | undefined;

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    style?: DefaultTextStyle
  ) {
    super(text, paddingX, paddingY, theme, style);
    this.#source = text;
    this.#paddingX = paddingX;
    this.#paddingY = paddingY;
    this.#theme = theme;
    this.#style = style;
  }
  override setText(text: string): void {
    this.#source = text;
    super.setText(text);
  }
  captureCold(width: number): ColdContent {
    const { highlightCode, codeBlockIndent, ...styles } = this.#theme;
    const highlighted: Record<string, readonly string[]> = {};
    if (highlightCode) {
      // Highlight once synchronously while HOT. COLD only looks up copied runs.
      const capturingTheme = {
        ...this.#theme,
        highlightCode: (code: string, language?: string) => {
          const lines = highlightCode(code, language);
          highlighted[JSON.stringify([code, language])] = [...lines];
          return lines;
        },
      };
      new Markdown(
        this.#source,
        this.#paddingX,
        this.#paddingY,
        capturingTheme,
        this.#style
      ).render(width);
    }
    const theme = {
      ...Object.fromEntries(
        Object.entries(styles).map(([key, value]) => [key, captureStyle(value)])
      ),
      codeBlockIndent,
      ...(highlightCode ? { highlighted } : {}),
    } as ColdTheme;
    const { color, bgColor, ...flags } = this.#style ?? {};
    return preservePresentation(
      {
        kind: "markdown",
        text: this.#source,
        paddingX: this.#paddingX,
        paddingY: this.#paddingY,
        theme,
        defaultStyle: this.#style && {
          ...flags,
          color: color && captureStyle(color),
          bgColor: bgColor && captureStyle(bgColor),
        },
      },
      super.render(width),
      width
    );
  }
}
