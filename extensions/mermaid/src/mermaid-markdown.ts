import {
  type Component,
  Markdown,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { renderMermaidArt } from "./mermaid-renderer";

const MAX_SOURCE_LENGTH = 32_768;
const MAX_ART_CACHE_ENTRIES = 128;
const MARKDOWN_LINES_PATTERN = /.*(?:\n|$)/g;
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/;

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
  requestRender?: () => void;
  signal?: AbortSignal;
}

interface DiagramRenderState {
  art?: readonly string[];
  status: "failed" | "pending" | "ready";
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
  private cachedLines: string[] | undefined;
  private cachedText: string | undefined;
  private cachedWidth: number | undefined;
  private readonly controller = new AbortController();
  private readonly delegateViews = new Map<
    string,
    { dispose?(): void; render(width: number): string[] }
  >();
  private disposed = false;
  private readonly options: MermaidMarkdownOptions;
  private readonly paddingX: number;
  private readonly paddingY: number;
  private readonly renderStates = new Map<string, DiagramRenderState>();
  private readonly signal: AbortSignal;
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
    this.signal =
      options.signal === undefined
        ? this.controller.signal
        : AbortSignal.any([this.controller.signal, options.signal]);
    this.startRenderJobs();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeDelegateViews();
    this.controller.abort();
  }

  setText(text: string): void {
    if (this.disposed || text === this.text) {
      return;
    }
    this.text = text;
    this.disposeDelegateViews();
    this.invalidate();
    this.startRenderJobs();
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
        const state = this.renderStates.get(part.source);
        if (state?.status === "ready" && state.art !== undefined) {
          for (const artLine of state.art) {
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

  private startRenderJobs(): void {
    if (this.signal.aborted || !this.mermaidEnabled()) {
      return;
    }
    for (const part of extractMermaidBlocks(this.text)) {
      if (!(part.type === "mermaid" && part.source)) {
        continue;
      }
      const source = part.source;
      if (this.renderStates.has(source)) {
        continue;
      }
      // Evicting here would re-enqueue the source on the next streaming
      // update, and inserting a marker would grow the map without bound;
      // skip entirely so a diagram flood degrades to source-only output.
      if (this.renderStates.size >= MAX_ART_CACHE_ENTRIES) {
        continue;
      }
      const state: DiagramRenderState = { status: "pending" };
      this.renderStates.set(source, state);
      renderMermaidArt(source, this.signal).then(
        (art) => {
          if (this.signal.aborted) {
            return;
          }
          state.art = art;
          state.status = art === undefined ? "failed" : "ready";
          this.invalidate();
          this.options.requestRender?.();
        },
        () => {
          if (this.signal.aborted) {
            return;
          }
          state.status = "failed";
          this.invalidate();
          this.options.requestRender?.();
        }
      );
    }
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
