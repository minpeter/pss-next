import {
  Container,
  type MarkdownTheme,
  Spacer,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { parsePartialJson } from "ai";
import { BodyViewport, renderBodyTail } from "./body-viewport";
import { type ColdContent, captureStyle, selectTextTail } from "./cold-content";
import {
  createSpinnerTicker,
  type SpinnerTicker,
  stylePendingIndicator,
} from "./pending-spinner";
import {
  SnapshotMarkdown as Markdown,
  SnapshotText as Text,
} from "./snapshot-views";
import { sanitizeTerminalText } from "./terminal-safety";

const UNKNOWN_TOOL_NAME = "tool";
const TRAILING_NEWLINES = /\n+$/;
const TAB_PATTERN = /\t/g;
const BACKTICK_FENCE_PATTERN = /`{3,}/g;

const ANSI_RESET = "\x1b[0m";
const ANSI_BG_GRAY = "\x1b[100m";
const ANSI_BG_DARK_RED = "\x1b[48;5;88m";

const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const renderCodeBlock = (language: string, value: unknown): string => {
  const text = sanitizeTerminalText(safeStringify(value)).replace(
    TRAILING_NEWLINES,
    ""
  );
  const longestFenceRun = Array.from(
    text.matchAll(BACKTICK_FENCE_PATTERN)
  ).reduce((max, match) => Math.max(max, match[0].length), 2);
  const fence = "`".repeat(longestFenceRun + 1);
  return `${fence}${language}\n${text}\n${fence}`;
};

// Strings stay decoded (especially multiline source) rather than being
// re-escaped by JSON.stringify. The pretty-block boundary sanitizes every field.
const formatInputPreview = (value: unknown): string => {
  if (typeof value !== "object" || value === null) {
    return safeStringify(value);
  }
  const fields = Object.entries(value);
  if (fields.length === 0) {
    return safeStringify(value);
  }
  return fields
    .map(([key, field]) => `${key}: ${formatInputPreview(field)}`)
    .join("\n");
};

const isPlainEmptyObject = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).length === 0;
};

const applyGrayBackground = (text: string): string =>
  `${ANSI_BG_GRAY}${text}${ANSI_RESET}`;

const applyErrorBackground = (text: string): string =>
  `${ANSI_BG_DARK_RED}${text}${ANSI_RESET}`;

class TrimmedMarkdown extends Markdown {
  override captureCold(width: number): ColdContent {
    const content = super.captureCold(width);
    return content.kind === "markdown"
      ? { ...content, trimEnd: true }
      : content;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim().length === 0) {
      end -= 1;
    }
    return lines.slice(0, end);
  }
}

class BackgroundBody {
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private backgroundFn: (text: string) => string;
  private backgroundEnabled = true;
  private readonly paddingX: number;
  private text: string;

  constructor(
    text: string,
    paddingX: number,
    backgroundFn: (text: string) => string
  ) {
    this.text = text;
    this.paddingX = paddingX;
    this.backgroundFn = backgroundFn;
  }

  setText(text: string): void {
    this.text = text;
    this.invalidate();
  }

  setBackground(backgroundFn: (text: string) => string): void {
    this.backgroundFn = backgroundFn;
    this.invalidate();
  }

  setBackgroundEnabled(enabled: boolean): void {
    if (this.backgroundEnabled === enabled) {
      return;
    }
    this.backgroundEnabled = enabled;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  captureCold(width: number): ColdContent {
    if (!this.text.trim()) {
      return { kind: "group", children: [] };
    }
    const content = selectTextTail(
      {
        kind: "text",
        text: this.text,
        paddingX: this.paddingX,
        paddingY: 0,
        background: this.backgroundEnabled
          ? captureStyle(this.backgroundFn)
          : undefined,
      },
      width,
      8
    );
    return { kind: "group", children: [{ kind: "spacer", rows: 1 }, content] };
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedText === this.text &&
      this.cachedWidth === width
    ) {
      return this.cachedLines;
    }

    if (!this.text || this.text.trim().length === 0) {
      this.cachedText = this.text;
      this.cachedWidth = width;
      this.cachedLines = [];
      return [];
    }

    const normalizedText = this.text.replace(TAB_PATTERN, "   ");
    const padding = Math.min(
      this.paddingX,
      Math.max(0, Math.floor((width - 1) / 2))
    );
    const contentWidth = Math.max(1, width - padding * 2);
    const leftMargin = " ".repeat(padding);
    const rightMargin = " ".repeat(padding);

    const renderedLines = renderBodyTail([normalizedText], contentWidth).map(
      (line) => {
        const lineWithMargins = `${leftMargin}${line}${rightMargin}`;
        const visLen = visibleWidth(lineWithMargins);
        const paddedLine = `${lineWithMargins}${" ".repeat(Math.max(0, width - visLen))}`;

        return this.backgroundEnabled
          ? this.backgroundFn(paddedLine)
          : paddedLine;
      }
    );

    const result = ["", ...renderedLines];
    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = result;
    return result;
  }
}

export interface ToolRendererMap {
  [toolName: string]: (
    view: BaseToolCallView,
    input: unknown,
    output: unknown
  ) => void;
}

export class BaseToolCallView extends Container {
  private readonly callId: string;
  private readonly content = new Container();
  private readonly markdownTheme: MarkdownTheme;
  private readonly renderers?: ToolRendererMap;
  private readonly showRawToolIo: boolean;
  private displayMode: "content" | "pretty" | "pending" = "content";
  private disposed = false;
  private error: unknown;
  private finalInput: unknown;
  private inputBuffer = "";
  private output: unknown;
  private outputDenied = false;
  private outputDeniedReason: string | undefined;
  private parsedInput: unknown;
  private pendingIndicator: Text | null = null;
  private pendingTicker: SpinnerTicker | null = null;
  private prettyBlockActive = false;
  private readonly requestRender: () => void;
  private readBlock: Container | null = null;
  private readBody: BackgroundBody | null = null;
  private readHeader: TrimmedMarkdown | null = null;
  private renderedOverride: string | null = null;
  private toolName: string;

  constructor(
    callId: string,
    toolName: string,
    markdownTheme: MarkdownTheme,
    requestRender?: () => void,
    showRawToolIo?: boolean,
    renderers?: ToolRendererMap
  ) {
    super();
    this.callId = sanitizeTerminalText(callId);
    this.toolName = sanitizeTerminalText(toolName);
    this.markdownTheme = markdownTheme;
    this.showRawToolIo = showRawToolIo ?? false;
    this.renderers = renderers;
    this.requestRender = requestRender ?? (() => undefined);
    this.addChild(this.content);
    this.refresh();
  }

  settle(): void {
    if (this.pendingIndicator) {
      this.pendingIndicator.setText("Preparing tool call…");
    }
    this.stopPendingIndicator();
  }

  dispose(): void {
    this.disposed = true;
    this.stopPendingIndicator();
  }

  async appendInputChunk(chunk: string): Promise<void> {
    this.inputBuffer += chunk;
    const { value, state } = await parsePartialJson(this.inputBuffer);
    if (this.disposed) {
      return;
    }
    // Suppress transient empty objects during partial parsing to prevent
    // renderers from briefly showing "(unknown)" headers before real data arrives.
    if (state !== "successful-parse" && isPlainEmptyObject(value)) {
      return;
    }
    this.parsedInput = value;
    this.refresh();
  }

  setError(error: unknown): void {
    this.error = error;
    this.refresh();
  }

  setFinalInput(input: unknown): void {
    this.finalInput = input;
    this.refresh();
  }

  setOutput(output: unknown): void {
    this.output = output;
    this.refresh();
  }

  setOutputDenied(reason?: string): void {
    this.outputDenied = true;
    this.outputDeniedReason =
      reason === undefined ? undefined : sanitizeTerminalText(reason);
    this.refresh();
  }

  setToolName(toolName: string): void {
    this.toolName = sanitizeTerminalText(toolName);
    this.refresh();
  }

  setRenderedOverride(markdown: string): void {
    this.renderedOverride = sanitizeTerminalText(markdown);
  }

  getError(): unknown {
    return this.error;
  }

  isOutputDenied(): boolean {
    return this.outputDenied;
  }

  /**
   * Public API for custom tool renderers. Sets a pretty block with Markdown
   * header and ANSI-backgrounded body.
   */
  setPrettyBlock(
    header: string,
    body: string,
    options?: {
      allowAnsi?: boolean;
      isError?: boolean;
      isPending?: boolean;
      useBackground?: boolean;
    }
  ): void {
    if (this.disposed) {
      return;
    }
    this.prettyBlockActive = true;
    this.ensurePrettyBlockComponents();

    if (!(this.readBody && this.readHeader && this.readBlock)) {
      return;
    }

    this.setDisplayMode("pretty");

    if (options?.isError) {
      this.readBody.setBackground(applyErrorBackground);
    } else {
      this.readBody.setBackground(applyGrayBackground);
    }

    this.readBody.setBackgroundEnabled(options?.useBackground ?? true);
    this.readHeader.setText(sanitizeTerminalText(header));
    this.readBody.setText(
      options?.allowAnsi ? body : sanitizeTerminalText(body)
    );
  }

  private ensurePrettyBlockComponents(): void {
    if (this.readBlock) {
      return;
    }

    const header = new TrimmedMarkdown("", 1, 0, this.markdownTheme);
    const body = new BackgroundBody("", 1, applyGrayBackground);
    const block = new Container();
    block.addChild(header);
    block.addChild(body);

    this.readHeader = header;
    this.readBody = body;
    this.readBlock = block;
  }

  private setDisplayMode(mode: "content" | "pretty" | "pending"): void {
    if (this.displayMode === mode) {
      return;
    }
    this.displayMode = mode;
    this.clear();
    if (mode === "pending") {
      this.addChild(this.ensurePendingIndicator());
      return;
    }
    this.stopPendingIndicator();
    if (mode === "pretty" && this.readBlock) {
      this.addChild(this.readBlock);
    } else {
      this.addChild(this.content);
    }
  }

  private ensurePendingIndicator(): Text {
    if (this.pendingIndicator && this.pendingTicker) {
      return this.pendingIndicator;
    }
    const indicator = new Text("", 1, 0);
    this.pendingIndicator = indicator;
    this.pendingTicker = createSpinnerTicker((frame) => {
      indicator.setText(stylePendingIndicator(frame, "Preparing tool call…"));
      this.requestRender();
    });
    return indicator;
  }

  private stopPendingIndicator(): void {
    if (this.pendingTicker) {
      this.pendingTicker.stop();
      this.pendingTicker = null;
    }
    this.pendingIndicator = null;
  }

  private isEmptyState(): boolean {
    return (
      this.finalInput === undefined &&
      this.output === undefined &&
      this.error === undefined &&
      !this.outputDenied &&
      this.parsedInput === undefined &&
      this.inputBuffer.length === 0 &&
      !this.prettyBlockActive &&
      this.renderedOverride === null
    );
  }

  private resolveBestInput(): unknown {
    if (this.finalInput !== undefined) {
      return this.finalInput;
    }

    if (this.parsedInput !== undefined) {
      return this.parsedInput;
    }

    if (this.inputBuffer.length > 0) {
      return this.inputBuffer;
    }

    return;
  }

  private tryRenderWithCustomRenderer(bestInput: unknown): boolean {
    if (this.outputDenied) {
      return false;
    }

    const renderer = this.renderers?.[this.toolName];
    if (!renderer) {
      return false;
    }

    this.renderedOverride = null;
    this.prettyBlockActive = false;
    renderer(this, bestInput, this.output);
    return this.renderedOverride !== null || this.prettyBlockActive;
  }

  private shouldRenderInputPreview(): boolean {
    if (this.showRawToolIo) {
      return false;
    }

    return (
      this.output === undefined &&
      this.error === undefined &&
      !this.outputDenied &&
      this.inputBuffer.length > 0
    );
  }

  private refresh(): void {
    if (this.disposed) {
      return;
    }
    if (this.isEmptyState()) {
      this.setDisplayMode("pending");
      return;
    }

    const bestInput = this.resolveBestInput();

    // Own streamed arguments until a result/error arrives: result renderers may
    // intentionally claim an empty body, or require fields not yet received.
    // Keep this same preview across the complete-input/execution boundary.
    if (this.shouldRenderInputPreview()) {
      this.setPrettyBlock(
        `**${this.toolName || UNKNOWN_TOOL_NAME}** input`,
        formatInputPreview(bestInput)
      );
      return;
    }

    if (!this.showRawToolIo && this.tryRenderWithCustomRenderer(bestInput)) {
      if (this.prettyBlockActive) {
        return;
      }
      if (this.renderedOverride) {
        this.setDisplayMode("content");
        this.content.clear();
        this.content.addChild(
          new BodyViewport(
            new TrimmedMarkdown(this.renderedOverride, 1, 0, this.markdownTheme)
          )
        );
        return;
      }
    }

    this.setDisplayMode("content");

    const resolvedToolName = this.toolName || UNKNOWN_TOOL_NAME;
    this.content.clear();
    this.content.addChild(
      new TrimmedMarkdown(
        `**Tool** \`${resolvedToolName}\` (\`${this.callId}\`)`,
        1,
        0,
        this.markdownTheme
      )
    );
    const sections = [
      { label: "Input", language: "json", value: bestInput },
      { label: "Output", language: "text", value: this.output },
      { label: "Error", language: "text", value: this.error },
    ];
    for (const { label, language, value } of sections) {
      if (value === undefined) {
        continue;
      }
      this.content.addChild(new Spacer(1));
      this.content.addChild(
        new TrimmedMarkdown(`**${label}**`, 1, 0, this.markdownTheme)
      );
      this.content.addChild(new Spacer(1));
      this.content.addChild(
        new BodyViewport(
          new TrimmedMarkdown(
            renderCodeBlock(language, value),
            1,
            0,
            this.markdownTheme
          )
        )
      );
    }

    if (this.outputDenied) {
      this.content.addChild(new Spacer(1));
      this.content.addChild(
        new TrimmedMarkdown(
          this.outputDeniedReason
            ? `**Output** denied: ${this.outputDeniedReason}`
            : "**Output** denied by model/policy",
          1,
          0,
          this.markdownTheme
        )
      );
    }
  }
}

export type ToolCallView = BaseToolCallView;
