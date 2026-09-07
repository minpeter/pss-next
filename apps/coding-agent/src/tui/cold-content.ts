import {
  type Component,
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  stripTerminalSequences,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
  type ColdTable,
  renderColdTable,
  selectMarkdownTables,
} from "./cold-table";

const HARD_BREAK = /\r\n|\r|\n/;

/** Renderer-free values. A snapshot must describe the presentation, not new input. */
export type ColdContent =
  | ColdTable
  | { readonly kind: "group"; readonly children: readonly ColdContent[] }
  | { readonly kind: "spacer"; readonly rows: number }
  | {
      readonly kind: "text";
      readonly text: string;
      readonly paddingX: number;
      readonly paddingY: number;
      readonly background?: ColdStyle;
    }
  | {
      readonly kind: "markdown";
      readonly text: string;
      readonly paddingX: number;
      readonly paddingY: number;
      readonly theme: ColdTheme;
      readonly defaultStyle?: ColdTextStyle;
      readonly trimEnd?: boolean;
    }
  | {
      readonly kind: "fixed";
      readonly rows: readonly string[];
      readonly reason: "graphics" | "opaque-renderer";
    }
  | {
      readonly kind: "selected";
      readonly content: ColdContent;
      readonly width: number;
      readonly rows: readonly string[];
    };

export interface ColdCapture {
  /** Called once at handoff. Return data only; no callbacks, views or producers. */
  captureCold(width: number): ColdContent;
}

export interface ColdStyle {
  readonly after: string;
  readonly before: string;
}
type StyleKey = Exclude<
  keyof MarkdownTheme,
  "highlightCode" | "codeBlockIndent"
>;
export type ColdTheme = Readonly<Record<StyleKey, ColdStyle>> & {
  readonly codeBlockIndent?: string;
  readonly highlighted?: Readonly<Record<string, readonly string[]>>;
};
export interface ColdTextStyle {
  readonly bgColor?: ColdStyle;
  readonly bold?: boolean;
  readonly color?: ColdStyle;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly underline?: boolean;
}

export const hasGraphics = (lines: readonly string[]): boolean =>
  lines.some(
    (line) =>
      line.includes("\x1b_G") ||
      line.includes("\x1b]1337;File=") ||
      line.includes("\x1bP")
  );

export const captureComponent = (
  component: Component,
  width: number
): ColdContent => {
  if (
    "captureCold" in component &&
    typeof component.captureCold === "function"
  ) {
    return component.captureCold(width);
  }
  if (component instanceof Spacer) {
    return { kind: "spacer", rows: component.render(width).length };
  }
  if (component instanceof Container) {
    return {
      kind: "group",
      children: component.children.map((child) =>
        captureComponent(child, width)
      ),
    };
  }
  const rows = component.render(width);
  return {
    kind: "fixed",
    rows: [...rows],
    reason: hasGraphics(rows) ? "graphics" : "opaque-renderer",
  };
};

export const captureStyle = (style: (text: string) => string): ColdStyle => {
  const marker = "\u0000";
  const styled = style(marker);
  const index = styled.indexOf(marker);
  // A non-wrapper theme is detected by the presentation equality check at capture.
  return index < 0
    ? { before: styled, after: "" }
    : { before: styled.slice(0, index), after: styled.slice(index + 1) };
};
const styleFunction =
  (style: ColdStyle) =>
  (text: string): string =>
    `${style.before}${text}${style.after}`;
export const restoreTheme = (theme: ColdTheme): MarkdownTheme => {
  const { highlighted, codeBlockIndent, ...styles } = theme;
  return {
    ...(Object.fromEntries(
      Object.entries(styles).map(([key, value]) => [key, styleFunction(value)])
    ) as Record<StyleKey, (text: string) => string>),
    codeBlockIndent,
    ...(highlighted
      ? {
          highlightCode: (code: string, language?: string) => {
            const rows = highlighted[JSON.stringify([code, language])];
            if (!rows) {
              throw new Error("Uncaptured COLD code highlighting");
            }
            return [...rows];
          },
        }
      : {}),
  };
};

export const renderColdContent = (
  content: ColdContent,
  width: number
): string[] => {
  switch (content.kind) {
    case "group":
      return content.children.flatMap((child) =>
        renderColdContent(child, width)
      );
    case "spacer":
      return Array.from({ length: content.rows }, () => "");
    case "table":
      return renderColdTable(content, width);
    case "fixed":
      return content.reason === "graphics"
        ? [...content.rows]
        : content.rows.flatMap((row) => wrapTextWithAnsi(row, width));
    case "selected":
      return width === content.width
        ? [...content.rows]
        : renderColdContent(content.content, width);
    case "text":
      return new Text(
        content.text,
        content.paddingX,
        content.paddingY,
        content.background && styleFunction(content.background)
      ).render(width);
    case "markdown": {
      const { color, bgColor, ...flags } = content.defaultStyle ?? {};
      const style = content.defaultStyle && {
        ...flags,
        color: color && styleFunction(color),
        bgColor: bgColor && styleFunction(bgColor),
      };
      const rows = new Markdown(
        content.text,
        content.paddingX,
        content.paddingY,
        restoreTheme(content.theme),
        style
      ).render(width);
      if (content.trimEnd) {
        while (rows.length && !rows.at(-1)?.trim()) {
          rows.pop();
        }
      }
      return rows;
    }
    default: {
      const unsupported: never = content;
      throw new Error(`Unsupported COLD content: ${String(unsupported)}`);
    }
  }
};

export const preservePresentation = (
  content: ColdContent,
  rows: string[],
  width: number
): ColdContent => {
  const captured = renderColdContent(content, width);
  return captured.length === rows.length &&
    captured.every((row, i) => row === rows[i])
    ? content
    : {
        kind: "fixed",
        rows: [...rows],
        reason: hasGraphics(rows) ? "graphics" : "opaque-renderer",
      };
};

/** Select once from logical text, retaining the hard/soft break distinction. */
export const selectTextTail = (
  content: Extract<ColdContent, { kind: "text" }>,
  width: number,
  count: number
): ColdContent => {
  const padding = Math.min(
    content.paddingX,
    Math.max(0, Math.floor((width - 1) / 2))
  );
  const available = Math.max(1, width - padding * 2);
  const text = content.text.replace(/\t/g, "   ");
  const wrapped = wrapTextWithAnsi(text, available);
  if (wrapped.length <= count) {
    return content;
  }
  const discarded = wrapped.length - count;
  // Re-wrap logical lines separately only to locate the selected boundary. The
  // actual suffix comes from the ANSI-aware full wrap, including inherited SGR/OSC8.
  let row = 0;
  let lineIndex = 0;
  const logical = text.split(HARD_BREAK);
  for (; lineIndex < logical.length; lineIndex += 1) {
    const length = wrapTextWithAnsi(logical[lineIndex], available).length;
    if (row + length > discarded) {
      break;
    }
    row += length;
  }
  const end = row + wrapTextWithAnsi(logical[lineIndex], available).length;
  const fragments = wrapped.slice(row, end);
  // wrapTextWithAnsi consumes whitespace at word boundaries. Keep those soft
  // separators, but do not insert spaces into split long words/CJK graphemes.
  const source = stripLayout(logical[lineIndex]);
  let offset = 0;
  let suffix = "";
  for (const [index, fragment] of fragments.entries()) {
    const plain = stripLayout(fragment);
    const start = source.indexOf(plain, offset);
    if (row + index >= discarded) {
      const separator =
        suffix && start > offset ? source.slice(offset, start) : "";
      suffix += separator + fragment;
    }
    offset = start < 0 ? offset : start + plain.length;
  }
  const remaining = wrapped.slice(end);
  // Use each following true source newline; carry ANSI state from the wrapped
  // first row, while retaining the following unwrapped logical line content.
  const following = logical.slice(lineIndex + 1);
  if (following.length && remaining.length) {
    suffix += `\n${following.join("\n")}`;
  }
  return {
    kind: "selected",
    width,
    rows: renderColdContent(content, width).slice(-count),
    content: { ...content, text: suffix, paddingY: 0 },
  };
};

// Only used to locate text within its known logical source, never to recover Markdown.
const stripLayout = (text: string): string => stripTerminalSequences(text);

/** Tail capture for source-backed Markdown uses its unwrapped styled logical lines.
 * Full Markdown keeps its source and table/code layout; no ANSI-to-Markdown recovery.
 */
export const selectColdTail = (
  content: ColdContent,
  width: number,
  count = 8
): ColdContent => {
  const rows = renderColdContent(content, width);
  if (rows.length <= count || hasGraphics(rows)) {
    return content;
  }
  if (content.kind === "spacer") {
    return { ...content, rows: count };
  }
  if (content.kind === "text") {
    return selectTextTail(content, width, count);
  }
  if (content.kind === "group") {
    let remaining = count;
    const children: ColdContent[] = [];
    for (const child of [...content.children].reverse()) {
      if (remaining <= 0) {
        break;
      }
      const size = renderColdContent(child, width).length;
      children.unshift(selectColdTail(child, width, remaining));
      remaining -= size;
    }
    return { kind: "group", children };
  }
  if (content.kind === "markdown") {
    const naturalWidth = content.text
      .split(HARD_BREAK)
      .reduce(
        (maximum, line) =>
          Math.max(maximum, visibleWidth(line.replaceAll("\t", "   ")) + 16),
        width
      );
    const logical = renderColdContent(
      { ...content, paddingX: 0, paddingY: 0 },
      naturalWidth
    ).map((line) => line.trimEnd());
    const tableSelection = selectMarkdownTables(
      logical,
      rows,
      width,
      count,
      content.paddingX
    );
    if (tableSelection) {
      return tableSelection;
    }
    const flow: Extract<ColdContent, { kind: "text" }> = {
      kind: "text",
      text: logical.join("\n"),
      paddingX: content.paddingX,
      paddingY: 0,
      background: content.defaultStyle?.bgColor,
    };
    return {
      kind: "selected",
      width,
      rows: rows.slice(-count),
      content: selectTextTail(flow, width, count),
    };
  }
  return { kind: "fixed", rows: rows.slice(-count), reason: "opaque-renderer" };
};
