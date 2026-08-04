import {
  type Component,
  Markdown,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { renderMermaidAscii } from "beautiful-mermaid";

const MAX_SOURCE_LENGTH = 32_768;
const MAX_ART_LINES = 80;
const MAX_ART_CACHE_ENTRIES = 128;
const MARKDOWN_LINES_PATTERN = /.*(?:\n|$)/g;
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/;
const HEADER_SEMICOLON_PATTERN =
  /^(\s*(?:graph|flowchart)\s+[A-Za-z]{2})\s*;+\s*/;
const TRAILING_SEMICOLON_PATTERN = /;[ \t]*$/gm;
const WIDE_CHAR_PATTERN =
  /[ᄀ-ᄟ⺠-〿ㄱ-㆏ㇰ-ㇿ㐀-䶿一-鿿ꥠ-꥿가-힯豈-﫿︰-﹯＀-￠￠-￦𛀀-𛅒𠀀-𪛟𪜀-𫜯😀-🯿]/gu;
const PLACEHOLDER_BASE = 0xe0_00;
const PLACEHOLDER_DIGIT = 0x7f;
const PLACEHOLDER_PATTERN = /[\uE000-\uE07F]{2}/g;

export interface MermaidBlockPart {
  raw: string;
  source?: string;
  type: "markdown" | "mermaid";
}

interface FenceMarker {
  char: string;
  info: string;
  length: number;
}

interface ActiveMermaidFence {
  char: string;
  length: number;
  lines: string[];
  start: number;
}

interface MarkdownTextStyle {
  bold?: boolean;
  color?: (text: string) => string;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

interface MermaidMarkdownOptions {
  defaultTextStyle?: MarkdownTextStyle;
  delegate?: (text: string) => {
    dispose?(): void;
    render(width: number): string[];
  };
}

const fenceMarker = (line: string): FenceMarker | undefined => {
  const marker = FENCE_LINE_PATTERN.exec(line);
  if (!marker?.[1]) {
    return;
  }
  return {
    char: marker[1][0] ?? "`",
    info: marker[2] ?? "",
    length: marker[1].length,
  };
};

const closesFence = (
  marker: FenceMarker,
  active: { char: string; length: number }
): boolean =>
  marker.char === active.char &&
  marker.length >= active.length &&
  marker.info === "";

const pushMermaidPart = (
  parts: MermaidBlockPart[],
  text: string,
  mermaid: ActiveMermaidFence,
  markdownStart: number,
  end: number
): number => {
  const source = mermaid.lines.join("\n").trim();
  const raw = text.slice(mermaid.start, end);
  if (markdownStart < mermaid.start) {
    parts.push({
      raw: text.slice(markdownStart, mermaid.start),
      type: "markdown",
    });
  }
  if (source.length > 0 && source.length <= MAX_SOURCE_LENGTH) {
    parts.push({ raw, source, type: "mermaid" });
  } else {
    parts.push({ raw, type: "markdown" });
  }
  return end;
};

interface ScanState {
  fence?: FenceMarker;
  markdownStart: number;
  mermaid?: ActiveMermaidFence;
  parts: MermaidBlockPart[];
}

const scanLine = (
  state: ScanState,
  text: string,
  line: string,
  offset: number,
  end: number
): void => {
  const marker = fenceMarker(line);
  if (state.mermaid !== undefined) {
    if (marker && closesFence(marker, state.mermaid)) {
      state.markdownStart = pushMermaidPart(
        state.parts,
        text,
        state.mermaid,
        state.markdownStart,
        end
      );
      state.mermaid = undefined;
      return;
    }
    state.mermaid.lines.push(line);
    return;
  }
  if (state.fence !== undefined) {
    if (marker && closesFence(marker, state.fence)) {
      state.fence = undefined;
    }
    return;
  }
  if (marker === undefined) {
    return;
  }
  if (marker.info.toLowerCase() === "mermaid") {
    state.mermaid = { ...marker, lines: [], start: offset };
  } else {
    state.fence = marker;
  }
};

/** Split complete mermaid fences out of Markdown, leaving the rest intact. */
export const extractMermaidBlocks = (text: string): MermaidBlockPart[] => {
  const state: ScanState = { markdownStart: 0, parts: [] };
  let offset = 0;

  for (const lineWithNewline of text.match(MARKDOWN_LINES_PATTERN) ?? []) {
    if (lineWithNewline.length === 0) {
      continue;
    }
    const line = lineWithNewline.endsWith("\n")
      ? lineWithNewline.slice(0, -1)
      : lineWithNewline;
    scanLine(state, text, line, offset, offset + lineWithNewline.length);
    offset += lineWithNewline.length;
  }

  if (state.markdownStart < text.length) {
    state.parts.push({
      raw: text.slice(state.markdownStart),
      type: "markdown",
    });
  }
  return state.parts.length === 0
    ? [{ raw: text, type: "markdown" }]
    : state.parts;
};

interface AsciiPreset {
  readonly boxBorderPadding: number;
  readonly paddingX: number;
  readonly paddingY: number;
}

const DEFAULT_PRESET: AsciiPreset = {
  boxBorderPadding: 1,
  paddingX: 5,
  paddingY: 5,
};
const TIGHT_PRESET: AsciiPreset = {
  boxBorderPadding: 1,
  paddingX: 2,
  paddingY: 2,
};

// beautiful-mermaid accepts the header only alone on the first line, while
// mermaid itself also allows `graph LR;` and single-line diagrams.
const normalizeDiagramSource = (source: string): string => {
  const match = HEADER_SEMICOLON_PATTERN.exec(source);
  const headerSplit =
    match === null ? source : `${match[1]}\n${source.slice(match[0].length)}`;
  return headerSplit.replace(TRAILING_SEMICOLON_PATTERN, "");
};

// beautiful-mermaid pads box art by UTF-16 length, so East Asian wide
// labels break alignment. Expand every wide label char into a private-use
// pair (two narrow columns, self-describing index), let the library lay out
// with correct widths, then collapse each pair back to the original glyph.
const expandWideChars = (
  source: string
): { expanded: string; wideChars: string[] } => {
  const wideChars: string[] = [];
  const expanded = source.replace(WIDE_CHAR_PATTERN, (char) => {
    const index = wideChars.length;
    wideChars.push(char);
    return (
      String.fromCodePoint(
        PLACEHOLDER_BASE + Math.floor(index / (PLACEHOLDER_DIGIT + 1))
      ) +
      String.fromCodePoint(PLACEHOLDER_BASE + (index % (PLACEHOLDER_DIGIT + 1)))
    );
  });
  return { expanded, wideChars };
};

const collapsePlaceholders = (
  art: string,
  wideChars: readonly string[]
): string =>
  art.replace(PLACEHOLDER_PATTERN, (pair) => {
    const index =
      ((pair.codePointAt(0) ?? 0) - PLACEHOLDER_BASE) *
        (PLACEHOLDER_DIGIT + 1) +
      ((pair.codePointAt(1) ?? 0) - PLACEHOLDER_BASE);
    return wideChars[index] ?? "";
  });

/** Render diagram source to box-art lines, or undefined when unsupported. */
export const renderDiagramArt = (source: string): string[] | undefined => {
  const normalized = normalizeDiagramSource(source.trim());
  if (normalized.length === 0 || normalized.length > MAX_SOURCE_LENGTH) {
    return;
  }
  const { expanded, wideChars } = expandWideChars(normalized);
  const render = (preset: AsciiPreset): string[] =>
    trimArtLines(
      collapsePlaceholders(
        renderMermaidAscii(expanded, { ...preset, colorMode: "none" }),
        wideChars
      )
    );
  let lines: string[];
  try {
    lines = render(DEFAULT_PRESET);
  } catch {
    return;
  }
  if (lines.length > MAX_ART_LINES) {
    try {
      lines = render(TIGHT_PRESET);
    } catch {
      return;
    }
  }
  return lines.length > MAX_ART_LINES ? undefined : lines;
};

const trimArtLines = (art: string): string[] => {
  const lines = art.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && (lines.at(-1) ?? "").length === 0) {
    lines.pop();
  }
  return lines;
};

const isBlankRenderLine = (line: string | undefined): boolean =>
  line !== undefined && line.trim().length === 0;

const appendMarkdownLines = (target: string[], rendered: string[]): void => {
  const startsWithBlank = isBlankRenderLine(rendered[0]);
  if (isBlankRenderLine(target.at(-1)) && startsWithBlank) {
    target.push(...rendered.slice(1));
  } else {
    target.push(...rendered);
  }
};

/** Markdown component that appends box-art diagrams under mermaid fences. */
export class MermaidMarkdown implements Component {
  private readonly artCache = new Map<string, string[] | undefined>();
  private cachedLines: string[] | undefined;
  private cachedText: string | undefined;
  private cachedWidth: number | undefined;
  private readonly delegateViews = new Map<
    string,
    { dispose?(): void; render(width: number): string[] }
  >();
  private disposed = false;
  private readonly options: MermaidMarkdownOptions;
  private readonly paddingX: number;
  private readonly paddingY: number;
  private text: string;
  private readonly theme: MarkdownTheme;

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    options: MermaidMarkdownOptions = {}
  ) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.theme = theme;
    this.options = options;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeDelegateViews();
  }

  setText(text: string): void {
    if (this.disposed || text === this.text) {
      return;
    }
    this.text = text;
    this.disposeDelegateViews();
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedText === this.text &&
      this.cachedWidth === width
    ) {
      return this.cachedLines;
    }

    if (!this.mermaidEnabled()) {
      return this.cache(
        width,
        this.renderMarkdown(this.text, this.paddingY, width)
      );
    }

    const parts = extractMermaidBlocks(this.text);
    if (!parts.some((part) => part.type === "mermaid")) {
      return this.cache(
        width,
        this.renderMarkdown(this.text, this.paddingY, width)
      );
    }

    const lines: string[] = [];
    const emptyLine = " ".repeat(width);
    lines.push(...Array.from({ length: this.paddingY }, () => emptyLine));
    for (const part of parts) {
      if (part.type === "mermaid" && part.source) {
        appendMarkdownLines(lines, this.renderMarkdown(part.raw, 0, width));
        const art = this.artFor(part.source);
        if (art !== undefined) {
          for (const artLine of art) {
            lines.push(this.fitArtLine(artLine, width));
          }
          lines.push("");
        }
      } else if (part.raw.length > 0) {
        appendMarkdownLines(lines, this.renderMarkdown(part.raw, 0, width));
      }
    }
    lines.push(...Array.from({ length: this.paddingY }, () => emptyLine));
    return this.cache(width, lines);
  }

  private artFor(source: string): string[] | undefined {
    const cached = this.artCache.get(source);
    if (cached !== undefined || this.artCache.has(source)) {
      return cached;
    }
    const art = renderDiagramArt(source);
    if (this.artCache.size >= MAX_ART_CACHE_ENTRIES) {
      const oldest = this.artCache.keys().next().value;
      if (oldest !== undefined) {
        this.artCache.delete(oldest);
      }
    }
    this.artCache.set(source, art);
    return art;
  }

  private fitArtLine(line: string, width: number): string {
    const available = Math.max(1, width - this.paddingX * 2);
    const clipped =
      visibleWidth(line) > available ? truncateToWidth(line, available) : line;
    return " ".repeat(this.paddingX) + clipped;
  }

  private renderMarkdown(
    text: string,
    paddingY: number,
    width: number
  ): string[] {
    const delegate = this.options.delegate;
    if (delegate === undefined) {
      return new Markdown(
        text,
        this.paddingX,
        paddingY,
        this.theme,
        this.options.defaultTextStyle
      ).render(width);
    }
    const lines = this.delegateMarkdown(delegate, text).render(width);
    if (paddingY <= 0) {
      return lines;
    }
    const emptyLine = " ".repeat(width);
    const margin = Array.from({ length: paddingY }, () => emptyLine);
    return [...margin, ...lines, ...margin];
  }

  private delegateMarkdown(
    delegate: (text: string) => {
      dispose?(): void;
      render(width: number): string[];
    },
    text: string
  ): { dispose?(): void; render(width: number): string[] } {
    const existing = this.delegateViews.get(text);
    if (existing !== undefined) {
      return existing;
    }
    const view = delegate(text);
    this.delegateViews.set(text, view);
    return view;
  }

  private disposeDelegateViews(): void {
    for (const view of this.delegateViews.values()) {
      view.dispose?.();
    }
    this.delegateViews.clear();
  }

  private cache(width: number, lines: string[]): string[] {
    this.cachedLines = lines;
    this.cachedText = this.text;
    this.cachedWidth = width;
    return lines;
  }

  private mermaidEnabled(): boolean {
    return process.env.PSS_MERMAID !== "0";
  }
}
