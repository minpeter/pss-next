import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Component,
  encodeKitty,
  getCapabilities,
  getCellDimensions,
  Markdown,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { decode } from "fast-png";
import { formulaCjkLocale, renderMathJaxPng } from "./mathjax-renderer";

const CACHE_VERSION = "mathjax-resvg-wasm-v1";
const DEFAULT_COLOR = "#767676";
const MATHJAX_DISPLAY_SCALE = 0.25;
const MAX_FORMULA_LENGTH = 8192;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_PNG_DIMENSION = 8192;
const MAX_PNG_PIXELS = 16 * 1024 * 1024;
const MAX_QUEUED_RENDERS = 32;
const PNG_SIGNATURE = "89504e470d0a1a0a";
const FENCED_CODE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/;
const LATEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MARKDOWN_LINES_PATTERN = /.*(?:\n|$)/g;
const SINGLE_ROW_TERMINATOR_PATTERN = /(?<!\\)\\(?=[ \t]*(?:\n|$))/g;
const BACKTICK_RUN_PATTERN = /`+/g;

const MAX_IMAGE_ROWS = 64;

export interface DisplayMathPart {
  formula?: string;
  raw: string;
  type: "markdown" | "math";
}

interface PngDimensions {
  heightPx: number;
  widthPx: number;
}

interface RenderedLatex extends PngDimensions {
  base64: string;
  displayHeightPx?: number;
  displayWidthPx?: number;
  imageId: number;
}

interface MathRenderState {
  image?: RenderedLatex;
  status: "failed" | "pending" | "ready";
}

interface MarkdownTextStyle {
  bold?: boolean;
  color?: (text: string) => string;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

interface LatexMarkdownOptions {
  defaultTextStyle?: MarkdownTextStyle;
  foregroundColor?: string;
  requestRender?: () => void;
  signal?: AbortSignal;
}

const isEscaped = (text: string, index: number): boolean => {
  let slashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
};

type TextRange = [number, number];
interface MarkdownFence {
  char: string;
  length: number;
}

const inlineCodeRanges = (line: string, offset: number): TextRange[] => {
  const ranges: TextRange[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const opening = line.indexOf("`", cursor);
    if (opening === -1) {
      break;
    }
    let runEnd = opening + 1;
    while (line[runEnd] === "`") {
      runEnd += 1;
    }
    const marker = "`".repeat(runEnd - opening);
    const closing = line.indexOf(marker, runEnd);
    const end = closing === -1 ? line.length : closing + marker.length;
    ranges.push([offset + opening, offset + end]);
    cursor = end;
  }
  return ranges;
};

const closesFence = (
  marker: string | undefined,
  fence: MarkdownFence
): boolean => marker?.[0] === fence.char && marker.length >= fence.length;

const markdownCodeRanges = (text: string): TextRange[] => {
  const ranges: TextRange[] = [];
  let offset = 0;
  let fence: MarkdownFence | undefined;

  for (const lineWithNewline of text.match(MARKDOWN_LINES_PATTERN) ?? []) {
    if (lineWithNewline.length === 0) {
      continue;
    }
    const line = lineWithNewline.endsWith("\n")
      ? lineWithNewline.slice(0, -1)
      : lineWithNewline;
    const fenceMarker = FENCED_CODE_PATTERN.exec(line)?.[1];
    const lineRange: TextRange = [offset, offset + lineWithNewline.length];

    if (fence) {
      ranges.push(lineRange);
      if (closesFence(fenceMarker, fence)) {
        fence = undefined;
      }
    } else if (fenceMarker) {
      fence = { char: fenceMarker[0] ?? "`", length: fenceMarker.length };
      ranges.push(lineRange);
    } else if (INDENTED_CODE_PATTERN.test(line)) {
      ranges.push(lineRange);
    } else {
      ranges.push(...inlineCodeRanges(line, offset));
    }
    offset += lineWithNewline.length;
  }

  return ranges;
};

const isInRanges = (index: number, ranges: TextRange[]): boolean =>
  ranges.some(([start, end]) => index >= start && index < end);

const findDelimiter = (
  text: string,
  delimiter: "$$" | "\\[" | "\\]",
  from: number,
  ranges: TextRange[]
): number => {
  let index = text.indexOf(delimiter, from);
  while (index !== -1) {
    if (!(isInRanges(index, ranges) || isEscaped(text, index))) {
      return index;
    }
    index = text.indexOf(delimiter, index + delimiter.length);
  }
  return -1;
};

interface DisplayMathMatch {
  end: number;
  formula: string;
  start: number;
}

const earlierDelimiter = (dollars: number, brackets: number): number => {
  if (dollars === -1) {
    return brackets;
  }
  if (brackets === -1) {
    return dollars;
  }
  return Math.min(dollars, brackets);
};

const findDisplayMath = (
  text: string,
  from: number,
  ranges: TextRange[]
): DisplayMathMatch | undefined => {
  let scanFrom = from;
  while (scanFrom < text.length) {
    const dollars = findDelimiter(text, "$$", scanFrom, ranges);
    const brackets = findDelimiter(text, "\\[", scanFrom, ranges);
    const opening = earlierDelimiter(dollars, brackets);
    if (opening === -1) {
      return;
    }

    const openDelimiter = opening === dollars ? "$$" : "\\[";
    const closeDelimiter = openDelimiter === "$$" ? "$$" : "\\]";
    const formulaStart = opening + openDelimiter.length;
    const closing = findDelimiter(text, closeDelimiter, formulaStart, ranges);
    if (closing === -1) {
      return;
    }
    const end = closing + closeDelimiter.length;
    const formula = text.slice(formulaStart, closing).trim();
    if (formula.length > 0 && formula.length <= MAX_FORMULA_LENGTH) {
      return { end, formula, start: opening };
    }
    scanFrom = end;
  }
  return;
};

/** Split Markdown display math while leaving fenced/inline code untouched. */
export const extractDisplayMath = (text: string): DisplayMathPart[] => {
  const ranges = markdownCodeRanges(text);
  const parts: DisplayMathPart[] = [];
  let cursor = 0;
  let match = findDisplayMath(text, cursor, ranges);

  while (match) {
    if (match.start > cursor) {
      parts.push({ raw: text.slice(cursor, match.start), type: "markdown" });
    }
    parts.push({
      formula: match.formula,
      raw: text.slice(match.start, match.end),
      type: "math",
    });
    cursor = match.end;
    match = findDisplayMath(text, cursor, ranges);
  }

  if (cursor < text.length) {
    parts.push({ raw: text.slice(cursor), type: "markdown" });
  }
  return parts.length === 0 ? [{ raw: text, type: "markdown" }] : parts;
};

const isWhitespaceCharacter = (value: string | undefined): boolean =>
  value !== undefined && value.trim().length === 0;

const isInlineDollar = (
  text: string,
  index: number,
  ranges: TextRange[]
): boolean =>
  text[index] === "$" &&
  text[index - 1] !== "$" &&
  text[index + 1] !== "$" &&
  !isEscaped(text, index) &&
  !isInRanges(index, ranges);

const inlineCodeSpan = (formula: string): string => {
  let longestBacktickRun = 0;
  for (const match of formula.matchAll(BACKTICK_RUN_PATTERN)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }
  const marker = "`".repeat(longestBacktickRun + 1);
  return `${marker}${formula}${marker}`;
};

/** Turn short $...$ math into Markdown code spans for terminal highlighting. */
export const highlightInlineMath = (text: string): string => {
  const ranges = markdownCodeRanges(text);
  let cursor = 0;
  let output = "";

  while (cursor < text.length) {
    const opening = text.indexOf("$", cursor);
    if (opening === -1) {
      break;
    }
    if (
      !isInlineDollar(text, opening, ranges) ||
      isWhitespaceCharacter(text[opening + 1])
    ) {
      output += text.slice(cursor, opening + 1);
      cursor = opening + 1;
      continue;
    }

    let closing = text.indexOf("$", opening + 1);
    while (
      closing !== -1 &&
      (!isInlineDollar(text, closing, ranges) ||
        isWhitespaceCharacter(text[closing - 1]))
    ) {
      closing = text.indexOf("$", closing + 1);
    }
    if (closing === -1 || text.slice(opening + 1, closing).includes("\n")) {
      output += text.slice(cursor);
      cursor = text.length;
      break;
    }

    const formula = text.slice(opening + 1, closing);
    output += text.slice(cursor, opening) + inlineCodeSpan(formula);
    cursor = closing + 1;
  }

  return output + text.slice(cursor);
};

const pngDimensions = (bytes: Buffer): PngDimensions | undefined => {
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE
  ) {
    return;
  }
  const widthPx = bytes.readUInt32BE(16);
  const heightPx = bytes.readUInt32BE(20);
  if (!(widthPx > 0 && heightPx > 0)) {
    return;
  }
  return { heightPx, widthPx };
};

export const latexColor = (foregroundColor?: string): string => {
  const configured = process.env.PSS_LATEX_COLOR;
  if (configured && LATEX_COLOR_PATTERN.test(configured)) {
    return configured.toLowerCase();
  }
  return foregroundColor && LATEX_COLOR_PATTERN.test(foregroundColor)
    ? foregroundColor.toLowerCase()
    : DEFAULT_COLOR;
};

const latexAspectCorrection = (): number => {
  const configured = Number(process.env.PSS_LATEX_ASPECT ?? "1");
  return Number.isFinite(configured)
    ? Math.max(0.75, Math.min(1.25, configured))
    : 1;
};

const latexDisplayScale = (): number => {
  const configured = Number(process.env.PSS_LATEX_SCALE ?? "1");
  const userScale = Number.isFinite(configured)
    ? Math.max(0.5, Math.min(2, configured))
    : 1;
  return MATHJAX_DISPLAY_SCALE * userScale;
};

const displayDimensions = ({
  heightPx,
  widthPx,
}: PngDimensions): { displayHeightPx: number; displayWidthPx: number } => {
  const scale = latexDisplayScale();
  return {
    displayHeightPx: Math.max(1, Math.ceil(heightPx * scale)),
    displayWidthPx: Math.max(1, Math.ceil(widthPx * scale)),
  };
};

const cacheDirectory = (): string =>
  process.env.PSS_LATEX_CACHE_DIR ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pss", "latex");

const formulaCacheKey = (formula: string, color: string): string =>
  createHash("sha256")
    .update(CACHE_VERSION)
    .update("\0")
    .update(color)
    .update("\0")
    .update(formulaCjkLocale(formula) ?? "non-cjk")
    .update("\0")
    .update(formula)
    .digest("hex");

let nextImageId = Math.floor(Math.random() * 0xff_ff_fe) + 1;
const allocateImageId = (): number => {
  const allocated = nextImageId;
  nextImageId = (nextImageId % 0xff_ff_ff) + 1;
  return allocated;
};

/** Repair the common LLM mistake of emitting one slash at a TeX row end. */
export const normalizeLatexFormula = (formula: string): string =>
  formula.replace(SINGLE_ROW_TERMINATOR_PATTERN, "\\\\");

const validatePng = (png: Buffer): PngDimensions => {
  if (png.length > MAX_PNG_BYTES) {
    throw new Error("LaTeX renderer produced an oversized PNG");
  }
  const dimensions = pngDimensions(png);
  if (!dimensionsWithinLimits(dimensions)) {
    throw new Error("LaTeX renderer produced an invalid or oversized PNG");
  }
  const decoded = decode(png);
  if (decoded.channels === 2 || decoded.channels === 4) {
    const alphaOffset = decoded.channels - 1;
    for (
      let index = alphaOffset;
      index < decoded.data.length;
      index += decoded.channels
    ) {
      if ((decoded.data[index] ?? 0) > 0) {
        return dimensions;
      }
    }
    throw new Error("LaTeX renderer produced a blank PNG");
  }
  return dimensions;
};

const readBoundedPng = async (path: string): Promise<Buffer> => {
  const noFollow =
    process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const file = await open(
    path,
    constants.O_RDONLY + constants.O_NONBLOCK + noFollow
  );
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw new Error("LaTeX cache entry is not a regular file");
    }
    if (metadata.size > MAX_PNG_BYTES) {
      throw new Error("LaTeX renderer produced an oversized PNG");
    }
    const buffer = Buffer.allocUnsafe(MAX_PNG_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes
      );
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_PNG_BYTES) {
      throw new Error("LaTeX renderer produced an oversized PNG");
    }
    const png = buffer.subarray(0, totalBytes);
    validatePng(png);
    return png;
  } finally {
    await file.close();
  }
};

const dimensionsWithinLimits = (
  dimensions: { heightPx: number; widthPx: number } | undefined
): dimensions is { heightPx: number; widthPx: number } =>
  dimensions !== undefined &&
  dimensions.widthPx <= MAX_PNG_DIMENSION &&
  dimensions.heightPx <= MAX_PNG_DIMENSION &&
  dimensions.widthPx * dimensions.heightPx <= MAX_PNG_PIXELS;

const renderLatex = async (
  formula: string,
  color: string,
  signal?: AbortSignal
): Promise<RenderedLatex> => {
  const key = formulaCacheKey(formula, color);
  const directory = cacheDirectory();
  const cachedPath = join(directory, `${key}.png`);
  try {
    const cached = await readBoundedPng(cachedPath);
    const dimensions = pngDimensions(cached);
    if (dimensionsWithinLimits(dimensions)) {
      return {
        ...dimensions,
        ...displayDimensions(dimensions),
        base64: cached.toString("base64"),
        imageId: 0,
      };
    }
  } catch {
    // A cache miss or corrupt entry falls through to the renderer.
  }

  signal?.throwIfAborted();
  const normalizedFormula = normalizeLatexFormula(formula);
  const png = await renderMathJaxPng(normalizedFormula, color, signal);
  const dimensions = validatePng(png);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryCachePath = join(
    directory,
    `.${key}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    await writeFile(temporaryCachePath, png, { mode: 0o600 });
    signal?.throwIfAborted();
    await rename(temporaryCachePath, cachedPath);
  } finally {
    await rm(temporaryCachePath, { force: true });
  }
  return {
    ...dimensions,
    ...displayDimensions(dimensions),
    base64: png.toString("base64"),
    imageId: 0,
  };
};

const renderQueue: Array<() => void> = [];
const renderPromises = new WeakMap<
  AbortSignal,
  Map<string, Promise<RenderedLatex>>
>();
let activeRenderCount = 0;
const MAX_CONCURRENT_RENDERS = 1;

const startQueuedRenders = (): void => {
  while (activeRenderCount < MAX_CONCURRENT_RENDERS && renderQueue.length > 0) {
    const start = renderQueue.shift();
    if (start) {
      activeRenderCount += 1;
      start();
    }
  }
};

const queueLatexRender = (
  formula: string,
  color: string,
  signal?: AbortSignal
): Promise<RenderedLatex> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (renderQueue.length >= MAX_QUEUED_RENDERS) {
      reject(new Error("LaTeX render queue is full"));
      return;
    }
    let started = false;
    const start = (): void => {
      started = true;
      signal?.removeEventListener("abort", abort);
      renderLatex(formula, color, signal).then(
        (rendered) => {
          resolve(rendered);
          activeRenderCount -= 1;
          startQueuedRenders();
        },
        (error: unknown) => {
          reject(error);
          activeRenderCount -= 1;
          startQueuedRenders();
        }
      );
    };
    const abort = (): void => {
      if (started) {
        return;
      }
      const index = renderQueue.indexOf(start);
      if (index >= 0) {
        renderQueue.splice(index, 1);
      }
      const reason = signal?.reason;
      reject(
        reason instanceof Error
          ? reason
          : new DOMException("The operation was aborted", "AbortError")
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    renderQueue.push(start);
    startQueuedRenders();
  });

const renderLatexCached = (
  formula: string,
  color: string,
  signal?: AbortSignal
): Promise<RenderedLatex> => {
  if (signal === undefined) {
    return queueLatexRender(formula, color);
  }
  const key = formulaCacheKey(formula, color);
  const pendingForSignal = renderPromises.get(signal) ?? new Map();
  renderPromises.set(signal, pendingForSignal);
  const existing = pendingForSignal.get(key);
  if (existing) {
    return existing;
  }
  const pending = queueLatexRender(formula, color, signal);
  pendingForSignal.set(key, pending);
  const evict = (): void => {
    if (pendingForSignal.get(key) === pending) {
      pendingForSignal.delete(key);
    }
  };
  pending.then(evict, evict);
  return pending;
};

/** Build a direct Kitty image line followed by its reserved terminal rows. */
export const kittyPlaceholderLines = (
  image: RenderedLatex,
  width: number,
  paddingX = 1
): string[] => {
  const availableWidth = Math.max(1, width - paddingX * 2);
  const cells = getCellDimensions();
  const displayHeightPx = image.displayHeightPx ?? image.heightPx;
  const displayWidthPx = image.displayWidthPx ?? image.widthPx;
  const columnsPerRow =
    (displayWidthPx / displayHeightPx) *
    (cells.heightPx / cells.widthPx) *
    latexAspectCorrection();
  let rows = Math.max(
    1,
    Math.min(MAX_IMAGE_ROWS, Math.round(displayHeightPx / cells.heightPx))
  );
  let columns = Math.max(1, Math.round(rows * columnsPerRow));
  if (columns > availableWidth) {
    columns = availableWidth;
    rows = Math.max(
      1,
      Math.min(MAX_IMAGE_ROWS, Math.round(columns / columnsPerRow))
    );
  }
  const leftMargin = " ".repeat(paddingX);
  const transmission = encodeKitty(image.base64, {
    columns,
    imageId: image.imageId,
    moveCursor: false,
    rows,
  });
  return [
    `${leftMargin}${transmission}`,
    ...Array.from({ length: rows - 1 }, () => ""),
  ];
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

const ensureDisplayMargin = (lines: string[]): void => {
  if (lines.length > 0 && !isBlankRenderLine(lines.at(-1))) {
    lines.push("");
  }
};

class LatexImage implements Component {
  private cachedLines: string[] | undefined;
  private cachedWidth: number | undefined;
  private readonly image: RenderedLatex;
  private readonly paddingX: number;

  constructor(image: RenderedLatex, paddingX: number) {
    this.image = image;
    this.paddingX = paddingX;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    this.cachedLines = kittyPlaceholderLines(this.image, width, this.paddingX);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}

/** Markdown component that upgrades complete display-math blocks on Kitty. */
export class LatexMarkdown implements Component {
  private cachedLines: string[] | undefined;
  private cachedText: string | undefined;
  private cachedWidth: number | undefined;
  private readonly controller = new AbortController();
  private disposed = false;
  private readonly formulaColor: string;
  private readonly options: LatexMarkdownOptions;
  private readonly paddingX: number;
  private readonly paddingY: number;
  private readonly renderStates = new Map<string, MathRenderState>();
  private text: string;
  private readonly theme: MarkdownTheme;
  private readonly signal: AbortSignal;

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    options: LatexMarkdownOptions = {}
  ) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.theme = theme;
    this.options = options;
    this.formulaColor = latexColor(options.foregroundColor);
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
    this.controller.abort();
  }

  setText(text: string): void {
    if (this.disposed || text === this.text) {
      return;
    }
    this.text = text;
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

    if (!this.latexEnabled()) {
      return this.cache(
        width,
        this.renderMarkdown(this.text, this.paddingY, width)
      );
    }

    const parts = extractDisplayMath(this.text);
    if (!parts.some((part) => part.type === "math")) {
      return this.cache(
        width,
        this.renderMarkdown(this.text, this.paddingY, width)
      );
    }

    const lines: string[] = [];
    const emptyLine = " ".repeat(width);
    lines.push(...Array.from({ length: this.paddingY }, () => emptyLine));
    for (const part of parts) {
      const state = part.formula
        ? this.renderStates.get(
            formulaCacheKey(part.formula, this.formulaColor)
          )
        : undefined;
      if (part.type === "math" && state?.status === "ready" && state.image) {
        ensureDisplayMargin(lines);
        lines.push(...new LatexImage(state.image, this.paddingX).render(width));
        lines.push("");
      } else if (part.raw.length > 0) {
        appendMarkdownLines(lines, this.renderMarkdown(part.raw, 0, width));
      }
    }
    lines.push(...Array.from({ length: this.paddingY }, () => emptyLine));
    return this.cache(width, lines);
  }

  private renderMarkdown(
    text: string,
    paddingY: number,
    width: number
  ): string[] {
    return new Markdown(
      highlightInlineMath(text),
      this.paddingX,
      paddingY,
      this.theme,
      this.options.defaultTextStyle
    ).render(width);
  }

  private cache(width: number, lines: string[]): string[] {
    this.cachedLines = lines;
    this.cachedText = this.text;
    this.cachedWidth = width;
    return lines;
  }

  private latexEnabled(): boolean {
    return (
      process.env.PSS_LATEX !== "0" && getCapabilities().images === "kitty"
    );
  }

  private startRenderJobs(): void {
    if (this.signal.aborted || !this.latexEnabled()) {
      return;
    }
    for (const part of extractDisplayMath(this.text)) {
      if (!(part.type === "math" && part.formula)) {
        continue;
      }
      const key = formulaCacheKey(part.formula, this.formulaColor);
      if (this.renderStates.has(key)) {
        continue;
      }
      const state: MathRenderState = { status: "pending" };
      this.renderStates.set(key, state);
      renderLatexCached(part.formula, this.formulaColor, this.signal).then(
        (image) => {
          if (this.signal.aborted) {
            return;
          }
          state.image = { ...image, imageId: allocateImageId() };
          state.status = "ready";
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
}
