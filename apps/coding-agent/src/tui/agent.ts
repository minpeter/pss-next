import {
  type Component,
  Container,
  Editor,
  type EditorTheme,
  getKeybindings,
  isFocusable,
  isKeyRelease,
  isKeyRepeat,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  type TUI,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentTurn, ModelUsage } from "@minpeter/pss-runtime";
import type { ModelMessage } from "ai";
import type { CodingAgentExtensionUi } from "../extensions/types";
import type { SessionIndexEntry } from "../sessions/session-index";
import { agentEventStreamParts } from "./agent-event-stream";
import {
  type AssistantRenderer,
  createAssistantRendererNotifications,
} from "./assistant-renderer";
import { createAliasAwareAutocompleteProvider } from "./autocomplete";
import { BusyStatus } from "./busy-status";
import {
  isCommand,
  parseCommand,
  type TuiCommand,
  type TuiCommandAction,
  type TuiCommandResult,
} from "./command";
import { buildTuiCommandSet, resolveTuiCommand } from "./command-set";
import { ctrlCPressDecision } from "./ctrl-c";
import { createTuiErrorPresentation } from "./error-presentation";
import { createExtensionUi } from "./extension-ui";
import {
  dispatchUserInput,
  type InputPreprocessHooks,
  type InputPreprocessResult,
  type InputThread,
} from "./input-routing";
import { ModelSelectorComponent } from "./model-selector";
import { createSpinnerTicker, type SpinnerTicker } from "./pending-spinner";
import { boundedReloadOperation } from "./reload";
import { type AppendedNotice, createRepeatedNotice } from "./repeated-notice";
import { createRetryStatus } from "./retry-status";
import {
  resumeSessionReplayParts,
  type SessionHistoryReplayPart,
  sessionHistoryReplayParts,
} from "./session-history-replay";
import { SessionSelectorComponent } from "./session-selector";
import { TuiSessionMachine } from "./session-state";
import { createSpinnerOrchestrator } from "./spinner-orchestrator";
import {
  addChatComponent,
  createInfoMessage,
  IGNORE_PART_TYPES,
  isVisibleStreamPart,
  type PiTuiRenderFlags,
  type PiTuiStreamState,
  STREAM_HANDLERS,
  type ToolInputRenderState,
  type TuiStreamPart,
} from "./stream-handlers";
import { AssistantStreamView } from "./stream-views";
import { terminalExitCursorSequence } from "./terminal-exit";
import { sanitizeTerminalText } from "./terminal-safety";
import { BaseToolCallView, type ToolRendererMap } from "./tool-call-view";

const ANSI_RESET = "\x1b[0m";
const ANSI_BLACK = "\x1b[30m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_BG_SOFT_LIGHT = "\x1b[48;5;249m";
const ANSI_BG_GRAY = "\x1b[100m";
const ANSI_BG_WHITE = "\x1b[47m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BRIGHT_CYAN = "\x1b[96m";
const ANSI_GRAY = "\x1b[38;5;245m";
const ANSI_ORANGE = "\x1b[38;5;208m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const CTRL_C_ETX = "\u0003";
const MODEL_SELECTOR_COMPACT_ROWS = 16;
const MODEL_SELECTOR_COMPACT_CHROME_ROWS = 4;
const MODEL_SELECTOR_STANDARD_CHROME_ROWS = 10;
const EXIT_REQUESTED = Symbol("exit-requested");

const style = (prefix: string, text: string): string =>
  `${prefix}${text}${ANSI_RESET}`;

const truncatePlainToWidth = (text: string, maxWidth: number): string => {
  if (maxWidth <= 0) {
    return "";
  }

  if (visibleWidth(text) <= maxWidth) {
    return text;
  }

  if (maxWidth === 1) {
    return "…";
  }

  let result = "";
  for (const char of text) {
    const candidate = `${result}${char}`;
    if (visibleWidth(candidate) >= maxWidth) {
      break;
    }
    result = candidate;
  }

  return `${result}…`;
};

interface FooterStatusEntry {
  level?: "error" | "info" | "warning";
  message: string;
  state: "ready" | "running";
}

export class FooterStatusBar extends Text {
  private ticker: SpinnerTicker | undefined;
  private currentFrame = "";
  private entries: FooterStatusEntry[] = [];
  private foregroundMessage: string | null = null;
  private rightText: string | undefined;
  private readonly tui: Pick<TUI, "requestRender">;

  constructor(tui: Pick<TUI, "requestRender">) {
    super("", 1, 0);
    this.tui = tui;
  }

  setEntries(entries: FooterStatusEntry[]): void {
    this.entries = [...entries];
    this.syncSpinnerTicker();
    this.invalidate();
    this.tui.requestRender();
  }

  setForegroundMessage(message: string | null): void {
    this.foregroundMessage = message;
    this.syncSpinnerTicker();
    this.invalidate();
    this.tui.requestRender();
  }

  getForegroundMessage(): string | null {
    return this.foregroundMessage;
  }

  setRightText(text: string | undefined): void {
    this.rightText = text?.trim() || undefined;
    this.invalidate();
    this.tui.requestRender();
  }

  stop(): void {
    this.ticker?.stop();
    this.ticker = undefined;
  }

  private resolveLeadingEntry(): FooterStatusEntry | undefined {
    if (this.foregroundMessage !== null) {
      return { message: this.foregroundMessage, state: "running" };
    }
    if (this.entries.length === 0) {
      return;
    }
    // The footer has a deliberately fixed one-row height so streaming status
    // changes cannot move the composer. Retain every status in that one row.
    return {
      level: this.entries[0]?.level,
      message: this.entries.map((entry) => entry.message).join(" · "),
      state: this.entries.some((entry) => entry.state === "running")
        ? "running"
        : "ready",
    };
  }

  render(width: number): string[] {
    if (width <= 0) {
      return [""];
    }

    if (
      this.entries.length === 0 &&
      this.foregroundMessage === null &&
      !this.rightText
    ) {
      // Keep a stable footer row even while there is no visible status.
      // Otherwise the footer alternates between zero and one row as a
      // spinner, tool status, or live token estimate appears/disappears;
      // once chat fills the viewport that shifts the editor up and down.
      // Pi's persistent footer has the same stabilising effect.
      return [this.padLine("", width)];
    }

    // At one column the glyph takes precedence over the usual left padding.
    const contentWidth = width === 1 ? 1 : width - 1;
    const lines: string[] = [];
    const leadingEntry = this.resolveLeadingEntry();
    const leadingLine = this.renderLeadingLine(
      width,
      contentWidth,
      leadingEntry
    );
    if (leadingLine !== null) {
      lines.push(leadingLine);
    }

    return lines;
  }

  private renderLeadingLine(
    width: number,
    contentWidth: number,
    leadingEntry: FooterStatusEntry | undefined
  ): string | null {
    const rightTextLimit = leadingEntry
      ? Math.max(0, Math.floor((contentWidth - 1) / 2))
      : contentWidth;
    const rightTextPlain = truncatePlainToWidth(
      this.rightText ?? "",
      rightTextLimit
    );
    if (!(leadingEntry || rightTextPlain)) {
      return null;
    }

    const minimumGap = leadingEntry && rightTextPlain ? 1 : 0;
    const maxLeftWidth = rightTextPlain
      ? Math.max(0, contentWidth - visibleWidth(rightTextPlain) - minimumGap)
      : contentWidth;
    const left =
      leadingEntry && maxLeftWidth > 0
        ? this.renderLeftEntry(leadingEntry, maxLeftWidth)
        : null;
    const leftWidth = left ? visibleWidth(left.plain) : 0;
    const gap = rightTextPlain
      ? Math.max(
          leftWidth > 0 ? 1 : 0,
          contentWidth - leftWidth - visibleWidth(rightTextPlain)
        )
      : 0;
    const rightTextStyled = rightTextPlain
      ? style(ANSI_DIM, rightTextPlain)
      : "";
    return this.padLine(
      `${width === 1 ? "" : " "}${left?.styled ?? ""}${" ".repeat(
        gap
      )}${rightTextStyled}`,
      width
    );
  }

  private renderLeftEntry(
    entry: FooterStatusEntry,
    maxWidth: number
  ): { plain: string; styled: string } {
    if (maxWidth <= 0) {
      return { plain: "", styled: "" };
    }

    const prefix = entry.state === "running" ? this.currentFrame : "";
    const prefixStyle =
      entry.state === "running" ? style(ANSI_CYAN, prefix) : "";
    const messageStylePrefix = this.resolveEntryStylePrefix(entry.level);
    const reservedPrefixWidth = prefix ? visibleWidth(prefix) + 1 : 0;
    const maxMessageWidth = Math.max(0, maxWidth - reservedPrefixWidth);
    const message = truncatePlainToWidth(entry.message, maxMessageWidth);

    return {
      plain: prefix ? `${prefix}${message ? ` ${message}` : ""}` : message,
      styled: prefix
        ? `${prefixStyle}${
            message ? ` ${style(messageStylePrefix, message)}` : ""
          }`
        : style(messageStylePrefix, message),
    };
  }

  private padLine(line: string, width: number): string {
    return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  }

  private syncSpinnerTicker(): void {
    const shouldRun =
      this.foregroundMessage !== null ||
      this.entries.some((entry) => entry.state === "running");
    if (shouldRun && this.ticker === undefined) {
      this.ticker = createSpinnerTicker((frame) => {
        this.currentFrame = frame;
        this.invalidate();
        this.tui.requestRender();
      });
    } else if (!shouldRun && this.ticker !== undefined) {
      this.ticker.stop();
      this.ticker = undefined;
    }
  }

  private resolveEntryStylePrefix(
    level: "error" | "info" | "warning" | undefined
  ): string {
    if (level === "error") {
      return ANSI_RED;
    }
    if (level === "warning") {
      return ANSI_YELLOW;
    }
    return ANSI_DIM;
  }
}

/**
 * Bottom-pinned, focus-owning composer. The chat is normal-flow content but
 * this component is rendered as an overlay, so a streaming Markdown reflow
 * can never alter the editor's screen row. It forwards focus and input to
 * whichever component currently occupies the editor slot.
 */
class ComposerLayer extends Container {
  #content: Component;
  readonly #footer: Component;
  readonly #afterInput: ((data: string) => void) | undefined;
  #focused = false;

  constructor(
    content: Component,
    footer: Component,
    afterInput?: (data: string) => void
  ) {
    super();
    this.#content = content;
    this.#footer = footer;
    this.#afterInput = afterInput;
    this.#rebuild();
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    if (isFocusable(this.#content)) {
      this.#content.focused = value;
    }
  }

  handleInput(data: string): void {
    this.#content.handleInput?.(data);
    this.#afterInput?.(data);
  }

  setContent(content: Component): void {
    this.#content = content;
    if (isFocusable(content)) {
      content.focused = this.#focused;
    }
    this.#rebuild();
  }

  #rebuild(): void {
    this.clear();
    this.addChild(this.#content);
    this.addChild(this.#footer);
  }
}

const createDefaultMarkdownTheme = (): MarkdownTheme => ({
  heading: (text) => style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, text),
  link: (text) => style(`${ANSI_BOLD}${ANSI_CYAN}`, text),
  linkUrl: (text) => style(ANSI_GRAY, text),
  code: (text) => style(ANSI_CYAN, text),
  codeBlock: (text) => style(ANSI_CYAN, text),
  codeBlockBorder: (text) => style(ANSI_GRAY, text),
  quote: (text) => style(ANSI_GRAY, text),
  quoteBorder: (text) => style(ANSI_GRAY, text),
  hr: (text) => style(ANSI_GRAY, text),
  listBullet: (text) => style(ANSI_CYAN, text),
  bold: (text) => style(ANSI_BOLD, text),
  italic: (text) => style(ANSI_DIM, text),
  strikethrough: (text) => style(ANSI_DIM, text),
  underline: (text) => style(ANSI_BOLD, text),
  codeBlockIndent: "  ",
});

const createDefaultEditorTheme = (): EditorTheme => ({
  borderColor: (text: string) => style(ANSI_GRAY, text),
  selectList: {
    selectedPrefix: (text: string) => style(`${ANSI_BOLD}${ANSI_CYAN}`, text),
    selectedText: (text: string) => style(ANSI_CYAN, text),
    description: (text: string) => style(ANSI_GRAY, text),
    scrollInfo: (text: string) => style(ANSI_DIM, text),
    noMatch: (text: string) => style(ANSI_DIM, text),
  },
});

const addUserMessage = (
  chatContainer: Container,
  markdownTheme: MarkdownTheme,
  message: string
): void => {
  addChatComponent(
    chatContainer,
    new Markdown(sanitizeTerminalText(message), 1, 1, markdownTheme, {
      bgColor: (text: string) =>
        style(`${ANSI_BG_SOFT_LIGHT}${ANSI_BLACK}`, text),
    })
  );
};

const addTranslatedMessage = (
  chatContainer: Container,
  markdownTheme: MarkdownTheme,
  message: string
): void => {
  chatContainer.addChild(new Spacer(1));
  chatContainer.addChild(
    new Markdown(sanitizeTerminalText(message), 1, 1, markdownTheme, {
      bgColor: (text: string) => style(ANSI_BG_GRAY, text),
    })
  );
};

/**
 * Appends a sanitized gray system notice row. Returns the mounted row and exact
 * string it was created with, so a repeated notice can restore that style
 * byte-for-byte after pulsing; `undefined` when nothing was appended.
 */
const appendSystemNotice = (
  chatContainer: Container,
  message: string
): AppendedNotice | undefined => {
  if (message.length === 0) {
    return;
  }

  const normalText = style(ANSI_GRAY, message);
  const row = new Text(normalText, 1, 0);
  addChatComponent(chatContainer, row);
  return { normalText, row };
};

const addErrorMessage = (chatContainer: Container, error: unknown): void => {
  const presentation = createTuiErrorPresentation(error);
  const lines = [
    style(`${ANSI_BOLD}${ANSI_RED}`, `× ${presentation.title}`),
    `  ${presentation.message}`,
    ...(presentation.hint === undefined
      ? []
      : [style(ANSI_GRAY, `  ${presentation.hint}`)]),
    ...(presentation.correlationIds ?? []).map(({ source, value }) =>
      style(ANSI_GRAY, `  ${source}: ${value}`)
    ),
  ];

  addChatComponent(chatContainer, new Text(lines.join("\n"), 1, 0));
};

interface StreamViewFactories {
  activeToolInputs: Map<string, ToolInputRenderState>;
  ensureAssistantView: () => AssistantStreamView;
  ensureToolView: (toolCallId: string, toolName: string) => BaseToolCallView;
  pendingToolCallIds: Set<string>;
  resetAssistantView: (suppressLeadingSpacer?: boolean) => void;
  streamedToolCallIds: Set<string>;
  toolViews: Map<string, BaseToolCallView>;
}

const createStreamViewFactories = (options: {
  assistantRenderer?: AssistantRenderer;
  assistantRendererSignal?: AbortSignal;
  assistantViews: Set<AssistantStreamView>;
  chatContainer: Container;
  flags: PiTuiRenderFlags;
  foregroundColor?: string;
  markdownTheme: MarkdownTheme;
  notifyAssistantRenderer: (message: string) => void;
  notifyAssistantRendererOnce: (key: string, message: string) => void;
  requestRender: () => void;
  toolRenderers?: ToolRendererMap;
}): StreamViewFactories => {
  const activeToolInputs = new Map<string, ToolInputRenderState>();
  const streamedToolCallIds = new Set<string>();
  const pendingToolCallIds = new Set<string>();
  const toolViews = new Map<string, BaseToolCallView>();
  let assistantView: AssistantStreamView | null = null;
  let suppressAssistantLeadingSpacer = false;

  const resetAssistantView = (suppressLeadingSpacer = false): void => {
    if (suppressLeadingSpacer) {
      suppressAssistantLeadingSpacer = true;
    }
    assistantView = null;
  };

  const ensureAssistantView = (): AssistantStreamView => {
    if (!assistantView) {
      assistantView = new AssistantStreamView(options.markdownTheme, {
        assistantRenderer: options.assistantRenderer,
        foregroundColor: options.foregroundColor,
        notify: options.notifyAssistantRenderer,
        notifyOnce: options.notifyAssistantRendererOnce,
        requestRender: options.requestRender,
        signal: options.assistantRendererSignal,
      });
      options.assistantViews.add(assistantView);
      addChatComponent(options.chatContainer, assistantView, {
        addLeadingSpacer: !suppressAssistantLeadingSpacer,
      });
      suppressAssistantLeadingSpacer = false;
    }

    return assistantView;
  };

  const ensureToolView = (
    toolCallId: string,
    toolName: string
  ): BaseToolCallView => {
    const existing = toolViews.get(toolCallId);
    if (existing) {
      existing.setToolName(toolName);
      return existing;
    }

    const view = new BaseToolCallView(
      toolCallId,
      toolName,
      options.markdownTheme,
      options.requestRender,
      options.flags.showRawToolIo,
      options.toolRenderers
    );
    toolViews.set(toolCallId, view);
    addChatComponent(options.chatContainer, view);
    return view;
  };

  return {
    activeToolInputs,
    streamedToolCallIds,
    pendingToolCallIds,
    toolViews,
    resetAssistantView,
    ensureAssistantView,
    ensureToolView,
  };
};

interface StreamPartTracker {
  finishReason: string | undefined;
  firstVisiblePartSeen: boolean;
}

const dispatchStreamPart = async (
  part: TuiStreamPart,
  context: {
    chatContainer: Container;
    flags: PiTuiRenderFlags;
    onFirstVisiblePart?: () => void;
    state: PiTuiStreamState;
    tracker: StreamPartTracker;
  }
): Promise<void> => {
  const { chatContainer, flags, onFirstVisiblePart, state, tracker } = context;

  if (part.type === "finish") {
    tracker.finishReason =
      typeof part.finishReason === "string" ? part.finishReason : undefined;
  }

  if (part.type === "error") {
    addErrorMessage(chatContainer, part.error);
    return;
  }

  if (!tracker.firstVisiblePartSeen && isVisibleStreamPart(part, flags)) {
    tracker.firstVisiblePartSeen = true;
    onFirstVisiblePart?.();
  }

  const handler = STREAM_HANDLERS[part.type];
  if (handler) {
    await handler(part, state);
  } else if (!IGNORE_PART_TYPES.has(part.type)) {
    state.resetAssistantView();
    addChatComponent(
      state.chatContainer,
      createInfoMessage("[unknown part]", part)
    );
  }
};

export type PreprocessResult = InputPreprocessResult;
export type PreprocessHooks = InputPreprocessHooks;

export interface CommandPreprocessHooks {
  addInputListener: (
    listener: (data: string) => { consume: boolean; data?: string } | undefined
  ) => () => void;
  clearStatus: () => void;
  editorTheme: EditorTheme;
  handleCtrlCPress: () => void;
  isCtrlCInput: (data: string) => boolean;
  overlayContainer: Container;
  showMessage: (message: string) => void;
  tui: TUI;
  updateHeader: () => void;
}

/**
 * The slice of a pss-runtime `ThreadHandle` the interactive session drives.
 * `send` starts a turn and `interrupt` cancels the active one.
 */
export interface TuiThread extends InputThread {
  interrupt(): void;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentTUIConfig {
  assistantRenderer?: AssistantRenderer;
  assistantRendererSignal?: AbortSignal;
  commands?: TuiCommand[];
  cwd?: string;
  footer?: { text?: string };
  header?: { title: string; subtitle?: string };
  /**
   * Data source for the interactive `/model` selector. The picker itself is
   * rendered by the TUI (pi-style, swapped into the editor slot).
   */
  modelSelector?: {
    currentModelId(): string;
    listModelIds(): Promise<string[]>;
    switchModel(modelId: string): void | Promise<void>;
  };
  onCommandAction?: (action: TuiCommandAction) => void | Promise<void>;
  onContextUsage?: (
    snapshot: import("@minpeter/pss-runtime").ContextUsageSnapshot
  ) => void;
  onExtensionUiReady?: (
    createUi: (hostSignal?: AbortSignal) => CodingAgentExtensionUi
  ) => void | Promise<void>;
  onSetup?: () => void | Promise<void>;
  onTurnComplete?: (
    usage: TurnUsage | undefined,
    finishReason?: string,
    signal?: AbortSignal
  ) => Promise<void> | void;
  preprocessCommand?: (
    commandInput: string,
    hooks: CommandPreprocessHooks
  ) => Promise<string | null>;
  preprocessUserInput?: (
    input: string,
    hooks: PreprocessHooks
  ) => Promise<PreprocessResult | undefined>;
  replayHistoryOnStartup?: boolean;
  sessionSelector?: {
    currentSessionKey(): string;
    listSessions(): Promise<readonly SessionIndexEntry[]>;
    loadCurrentHistory(): Promise<readonly ModelMessage[]>;
    switchSession(sessionKey: string): Promise<void>;
  };
  setupMessages?: string[];
  showRawToolIo?: boolean;
  theme?: {
    editorTheme?: EditorTheme;
    foregroundColor?: string;
    markdownTheme?: MarkdownTheme;
  };
  thread: TuiThread;
  toolRenderers?: ToolRendererMap;
}

export async function createAgentTUI(config: AgentTUIConfig): Promise<void> {
  const turnCompletions = new Set<Promise<void>>();
  const completionFailures: unknown[] = [];
  const markdownTheme =
    config.theme?.markdownTheme ?? createDefaultMarkdownTheme();
  const editorTheme = config.theme?.editorTheme ?? createDefaultEditorTheme();
  let commandSet = buildTuiCommandSet(config.commands);

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  tui.setClearOnShrink(false);

  const headerContainer = new Container();
  const chatContainer = new Container();
  const overlayContainer = new Container();
  const footerStatusBar = new FooterStatusBar(tui);
  const assistantViews = new Set<AssistantStreamView>();
  const disposeAssistantViews = (): void => {
    for (const view of assistantViews) {
      view.dispose();
    }
    assistantViews.clear();
  };
  // Immediately repeated identical notices pulse the one visible row instead
  // of appending duplicates. Scope is the current notice instance only; see
  // `repeated-notice.ts`.
  const repeatedNotice = createRepeatedNotice({
    appendNotice: (message) => appendSystemNotice(chatContainer, message),
    chatContainer,
    pulseStyle: (message) => style(`${ANSI_BG_WHITE}${ANSI_BLACK}`, message),
    requestRender: () => tui.requestRender(),
  });
  const showSystemMessage = (message: string): void => {
    // Sanitize before either style is applied, including repeated custom notices.
    repeatedNotice.show(sanitizeTerminalText(message).trimEnd());
  };
  const clearChat = (): void => {
    disposeAssistantViews();
    chatContainer.clear();
    repeatedNotice.reset();
  };

  const assistantRendererNotifications =
    createAssistantRendererNotifications(showSystemMessage);

  const title = new Text("", 1, 0);
  const help = new Text(
    style(
      ANSI_DIM,
      "Enter to submit, Shift+Enter for newline, Esc to interrupt, Ctrl+C to clear, Ctrl+C twice to exit"
    ),
    1,
    0
  );

  const updateHeader = (): void => {
    const headerTitle = sanitizeTerminalText(
      config.header?.title ?? "Agent TUI"
    );
    const subtitle =
      config.header?.subtitle === undefined
        ? undefined
        : sanitizeTerminalText(config.header.subtitle);
    const footer = sanitizeTerminalText(config.footer?.text ?? "").trim();
    title.setText(
      subtitle
        ? `${style(`${ANSI_BOLD}${ANSI_ORANGE}`, headerTitle)}\n${style(
            ANSI_DIM,
            subtitle
          )}`
        : style(`${ANSI_BOLD}${ANSI_ORANGE}`, headerTitle)
    );
    footerStatusBar.setRightText(footer);
    tui.requestRender();
  };

  headerContainer.addChild(new Spacer(1));
  headerContainer.addChild(title);
  headerContainer.addChild(help);

  const editor = new Editor(tui, editorTheme, {
    paddingX: 1,
    autocompleteMaxVisible: 8,
  });
  let autocompleteProvider = createAliasAwareAutocompleteProvider({
    commands: commandSet.commands,
    basePath: config.cwd ?? process.cwd(),
  });
  const refreshCommandSet = (): void => {
    commandSet = buildTuiCommandSet(config.commands);
    autocompleteProvider = createAliasAwareAutocompleteProvider({
      commands: commandSet.commands,
      basePath: config.cwd ?? process.cwd(),
    });
    editor.setAutocompleteProvider(autocompleteProvider);
  };
  editor.setAutocompleteProvider(autocompleteProvider);
  const composerLayer = new ComposerLayer(editor, footerStatusBar, (data) => {
    // pi-tui's delete-to-line-start path does not refresh autocomplete. When
    // it clears the composer, explicitly reset its provider to discard any
    // highlighted stale completion before Enter can apply it.
    if (
      getKeybindings().matches(data, "tui.editor.deleteToLineStart") &&
      editor.getText().length === 0
    ) {
      editor.setAutocompleteProvider(autocompleteProvider);
    }
  });
  tui.addChild(headerContainer);
  tui.addChild(chatContainer);
  tui.addChild(overlayContainer);
  tui.addChild(composerLayer);
  tui.setFocus(composerLayer);

  const session = new TuiSessionMachine();
  let lastCtrlCPressAt = 0;
  const busy = new BusyStatus((message) =>
    footerStatusBar.setForegroundMessage(message)
  );
  let activeModelSelector: ModelSelectorComponent | undefined;
  let activeSessionSelector: SessionSelectorComponent | undefined;
  let commandInputListenerActive = false;
  const extensionUiController = new AbortController();
  const exitRequested = new Promise<typeof EXIT_REQUESTED>((resolve) => {
    extensionUiController.signal.addEventListener(
      "abort",
      () => resolve(EXIT_REQUESTED),
      { once: true }
    );
  });
  const untilExit = <T>(
    operation: Promise<T>
  ): Promise<T | typeof EXIT_REQUESTED> =>
    Promise.race([operation, exitRequested]);

  // Compatibility hooks reset this operation's label, not its busy lifetime.
  const clearStatus = (): void => busy.setMessage(null);
  const showLoader = (message: string): void =>
    busy.setMessage(sanitizeTerminalText(message));

  const clearPromptInput = (): void => {
    editor.setText("");
    tui.setFocus(composerLayer);
    tui.requestRender();
  };

  const cancelActiveTurn = (): boolean => {
    if (session.markInterrupted() === undefined) {
      return false;
    }

    config.thread.interrupt();
    return true;
  };

  const requestExit = (): void => {
    extensionUiController.abort();
    cancelActiveTurn();
    busy.dispose();
    session.close();
  };

  const isCtrlCInput = (data: string): boolean => {
    if (isKeyRelease(data) || isKeyRepeat(data)) {
      return false;
    }

    return data === CTRL_C_ETX || matchesKey(data, Key.ctrl("c"));
  };

  const isEscapeInput = (data: string): boolean => {
    if (isKeyRelease(data) || isKeyRepeat(data)) {
      return false;
    }

    return matchesKey(data, Key.escape);
  };

  const handleCtrlCPress = (): void => {
    const now = Date.now();
    if (ctrlCPressDecision(now, lastCtrlCPressAt) === "exit") {
      requestExit();
      return;
    }

    clearPromptInput();
    lastCtrlCPressAt = now;
  };

  const getModelSelectorLayout = (): {
    compact: boolean;
    maxVisibleModels: number;
  } => {
    const compact = tui.terminal.rows < MODEL_SELECTOR_COMPACT_ROWS;
    const chromeRows = compact
      ? MODEL_SELECTOR_COMPACT_CHROME_ROWS
      : MODEL_SELECTOR_STANDARD_CHROME_ROWS;
    return {
      compact,
      maxVisibleModels: Math.max(1, tui.terminal.rows - chromeRows),
    };
  };

  const onTerminalResize = (): void => {
    const selector = activeModelSelector;
    if (selector !== undefined) {
      const layout = getModelSelectorLayout();
      selector.setLayout(layout.maxVisibleModels, layout.compact);
    }
    const sessionSelector = activeSessionSelector;
    if (sessionSelector !== undefined) {
      const layout = getModelSelectorLayout();
      sessionSelector.setLayout(layout.maxVisibleModels, layout.compact);
    }
    tui.requestRender(true);
  };

  const removeInputListener = tui.addInputListener((data) => {
    if (isCtrlCInput(data) && !commandInputListenerActive) {
      handleCtrlCPress();
      return { consume: true };
    }
    if (
      isEscapeInput(data) &&
      !commandInputListenerActive &&
      session.activeTurn !== undefined
    ) {
      cancelActiveTurn();
      return { consume: true };
    }
    return;
  });

  const onSigInt = (): void => {
    handleCtrlCPress();
  };

  process.on("SIGINT", onSigInt);
  process.stdout.on("resize", onTerminalResize);

  const waitForInput = (): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      session.awaitInput(resolve);
      tui.setFocus(composerLayer);
      tui.requestRender();
    });

  const addInterruptedMessage = (): void => {
    addChatComponent(
      chatContainer,
      new Text(
        style(
          ANSI_RED,
          "■ interrupted - tell the model what to do differently."
        ),
        1,
        0
      )
    );
    tui.requestRender();
  };

  const addAbnormalFinishReasonMessage = (finishReason: string): void => {
    if (finishReason === "stop") {
      return;
    }

    addChatComponent(
      chatContainer,
      new Text(
        style(
          ANSI_RED,
          `■ response ended abnormally (finish reason: ${finishReason})`
        ),
        1,
        0
      )
    );
    tui.requestRender();
  };

  const renderAgentStream = async (
    stream: AsyncIterable<TuiStreamPart>,
    flags: PiTuiRenderFlags,
    onFirstVisiblePart?: () => void,
    loaderMessage?: string
  ): Promise<{ finishReason: string | undefined }> => {
    const {
      activeToolInputs,
      streamedToolCallIds,
      pendingToolCallIds,
      toolViews,
      resetAssistantView,
      ensureAssistantView,
      ensureToolView,
    } = createStreamViewFactories({
      assistantRenderer: config.assistantRenderer,
      assistantRendererSignal: config.assistantRendererSignal,
      assistantViews,
      chatContainer,
      flags,
      foregroundColor: config.theme?.foregroundColor,
      markdownTheme,
      notifyAssistantRenderer: assistantRendererNotifications.notify,
      notifyAssistantRendererOnce: assistantRendererNotifications.notifyOnce,
      requestRender: () => tui.requestRender(),
      toolRenderers: config.toolRenderers,
    });
    const tracker: StreamPartTracker = {
      finishReason: undefined,
      firstVisiblePartSeen: false,
    };

    const baseLoaderMessage = loaderMessage ?? busy.getMessage();
    const orchestrator = createSpinnerOrchestrator(
      {
        clearStatus,
        hasSpinner: () => busy.getMessage() !== undefined,
        setMessage: showLoader,
        showLoader,
      },
      baseLoaderMessage
    );
    const retryStatus = createRetryStatus({
      now: () => Date.now(),
      setMessage: (message) => {
        if (message === null) {
          orchestrator.onRetryWaitEnd();
        } else {
          orchestrator.onRetryWaitMessage(message);
        }
        tui.requestRender();
      },
    });

    const state: PiTuiStreamState = {
      flags,
      activeToolInputs,
      streamedToolCallIds,
      pendingToolCallIds,
      resetAssistantView,
      ensureAssistantView,
      ensureToolView,
      getToolView: (toolCallId: string) => toolViews.get(toolCallId),
      chatContainer,
      onReasoningStart: orchestrator.onReasoningStart,
      onReasoningEnd: orchestrator.onReasoningEnd,
      // Runtime tool-call/result events are committed after execution. They
      // must not claim physical execution; the turn's Working lease covers it.
      onRetryWait: retryStatus.scheduled,
      onRetryClear: retryStatus.clear,
    };

    try {
      for await (const part of stream) {
        await dispatchStreamPart(part, {
          chatContainer,
          flags,
          onFirstVisiblePart,
          state,
          tracker,
        });
        tui.requestRender();
      }
    } finally {
      // Turn end, abort, and error all land here: never leave a countdown
      // ticking or a stale wait banner behind for the next step or thread.
      retryStatus.clear();
      retryStatus.stop();
      for (const view of toolViews.values()) {
        view.dispose();
      }
    }

    return { finishReason: tracker.finishReason };
  };

  const renderSessionHistory = (
    replay?: readonly SessionHistoryReplayPart[]
  ): Promise<void> =>
    busy.run("Loading session history...", async () => {
      const selectorConfig = config.sessionSelector;
      if (selectorConfig === undefined) {
        return;
      }
      const parts =
        replay ??
        sessionHistoryReplayParts(await selectorConfig.loadCurrentHistory());
      let streamParts: TuiStreamPart[] = [];
      const flushStreamParts = async (): Promise<void> => {
        if (streamParts.length === 0) {
          return;
        }
        const pending = streamParts;
        streamParts = [];
        await renderAgentStream(
          (async function* () {
            yield* pending;
          })(),
          {
            showReasoning: true,
            showSteps: false,
            showFinishReason: false,
            showRawToolIo: config.showRawToolIo ?? false,
            showToolResults: true,
            showSources: false,
            showFiles: false,
          }
        );
      };
      for (const part of parts) {
        if (part.type === "stream") {
          streamParts.push(part.part);
          continue;
        }
        await flushStreamParts();
        if (part.type === "clear") {
          clearChat();
        } else {
          addUserMessage(chatContainer, markdownTheme, part.text);
        }
      }
      await flushStreamParts();
    });

  const accumulateUsage = (
    total: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    },
    usage: ModelUsage
  ): void => {
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.totalTokens +=
      usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  };

  const runSingleTurn = async (run: AgentTurn): Promise<void> => {
    session.beginTurn(run);
    editor.disableSubmit = false;
    tui.setFocus(composerLayer);

    const turnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let sawModelUsage = false;

    try {
      showLoader("Working...");

      const { finishReason } = await renderAgentStream(
        agentEventStreamParts(run.events(), {
          onContextUsage: (snapshot) => {
            config.onContextUsage?.(snapshot);
            updateHeader();
          },
          onModelUsage: (usage) => {
            sawModelUsage = true;
            accumulateUsage(turnUsage, usage);
            updateHeader();
          },
        }),
        {
          showReasoning: true,
          showSteps: false,
          showFinishReason: false,
          showRawToolIo: config.showRawToolIo ?? false,
          showToolResults: true,
          showSources: false,
          showFiles: false,
        },
        undefined,
        "Working..."
      );

      if (session.wasInterrupted(run)) {
        addInterruptedMessage();
        return;
      }

      const completion = busy
        .run("Finalizing...", () =>
          boundedReloadOperation(
            Promise.resolve(
              config.onTurnComplete?.(
                sawModelUsage ? { ...turnUsage } : undefined,
                finishReason,
                extensionUiController.signal
              )
            ),
            10_000,
            "Turn completion"
          )
        )
        .then(() => {
          if (!session.closed) {
            updateHeader();
          }
        })
        .catch((error) => {
          completionFailures.push(error);
        });
      turnCompletions.add(completion);
      completion.then(() => turnCompletions.delete(completion));

      if (finishReason !== undefined) {
        addAbnormalFinishReasonMessage(finishReason);
      }
    } finally {
      session.endTurn(run);
      clearStatus();
    }
  };

  const executeLocalCommand = async (
    input: string
  ): Promise<TuiCommandResult | null> => {
    const parsed = parseCommand(input);
    if (!parsed) {
      return null;
    }

    const command = resolveTuiCommand(commandSet, parsed.name);
    if (!command) {
      return null;
    }

    return await busy.run("Working...", () =>
      command.execute({ args: parsed.args })
    );
  };

  const preprocessCommandInput = async (
    input: string
  ): Promise<string | null> => {
    if (!config.preprocessCommand) {
      return input;
    }

    const preprocess = config.preprocessCommand;
    return await busy.run("Processing command...", () =>
      preprocess(input, {
        addInputListener: (listener) => {
          commandInputListenerActive = true;
          const resume = busy.suspend();
          const remove = tui.addInputListener(listener);
          return () => {
            remove();
            resume();
            commandInputListenerActive = false;
          };
        },
        clearStatus,
        tui,
        overlayContainer,
        editorTheme,
        isCtrlCInput,
        handleCtrlCPress,
        showMessage: showSystemMessage,
        updateHeader,
      })
    );
  };

  /**
   * pi-style model picker: swap the editor out of its slot for the selector
   * and focus it, so input flows through the TUI's focused-component path
   * (which filters Kitty key releases and re-renders after every key).
   * Resolves when the picker settles and the editor is restored.
   */
  const showModelSelector = async (initialQuery?: string): Promise<void> => {
    const selectorConfig = config.modelSelector;
    if (selectorConfig === undefined) {
      showSystemMessage("Model selection is not available.");
      tui.requestRender();
      return;
    }

    let modelIds: string[];
    try {
      const result = await untilExit(
        busy.run("Loading model catalog...", () =>
          selectorConfig.listModelIds()
        )
      );
      if (result === EXIT_REQUESTED) {
        return;
      }
      modelIds = result;
    } catch (error) {
      clearStatus();
      showSystemMessage(
        `Could not list models: ${
          error instanceof Error ? error.message : String(error)
        }. Switch directly with /model <model-id>.`
      );
      tui.requestRender();
      return;
    }
    clearStatus();
    if (modelIds.length === 0) {
      showSystemMessage(
        "The provider returned an empty model catalog. Switch directly with /model <model-id>."
      );
      tui.requestRender();
      return;
    }

    const resumeBusy = busy.suspend();
    const pendingSelection = new Promise<string | undefined>((resolve) => {
      // Let the selector own ctrl+c/escape while it is mounted.
      commandInputListenerActive = true;
      let selector: ModelSelectorComponent | undefined;
      let settled = false;
      const settle = (modelId: string | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        extensionUiController.signal.removeEventListener("abort", abort);
        commandInputListenerActive = false;
        if (activeModelSelector === selector) {
          activeModelSelector = undefined;
        }
        composerLayer.setContent(editor);
        tui.setFocus(composerLayer);
        tui.requestRender();
        resumeBusy();
        resolve(modelId);
      };
      // Exit must settle the selector through the same idempotent path as
      // Escape; otherwise it stays mounted with input capture still active
      // after the TUI has stopped.
      const abort = () => settle(undefined);
      extensionUiController.signal.addEventListener("abort", abort, {
        once: true,
      });
      const layout = getModelSelectorLayout();
      selector = new ModelSelectorComponent({
        compact: layout.compact,
        currentModelId: selectorConfig.currentModelId(),
        ...(initialQuery === undefined ? {} : { initialQuery }),
        maxVisibleModels: layout.maxVisibleModels,
        modelIds,
        onCancel: () => settle(undefined),
        onSelect: (modelId) => settle(modelId),
      });
      activeModelSelector = selector;
      composerLayer.setContent(selector);
      tui.setFocus(composerLayer);
      tui.requestRender();
    });
    const selection = await untilExit(pendingSelection);

    if (selection === undefined || selection === EXIT_REQUESTED) {
      return;
    }
    try {
      await busy.run("Switching model...", () =>
        selectorConfig.switchModel(selection)
      );
      updateHeader();
      showSystemMessage(
        `Model switched to ${selection}. New steps use it immediately.`
      );
    } catch (error) {
      showSystemMessage(
        `Model switch failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    tui.requestRender();
  };

  const showSessionSelector = async (initialQuery?: string): Promise<void> => {
    const selectorConfig = config.sessionSelector;
    if (selectorConfig === undefined) {
      showSystemMessage("Session selection is not available.");
      tui.requestRender();
      return;
    }

    let sessions: readonly SessionIndexEntry[];
    try {
      const result = await untilExit(
        busy.run("Loading sessions...", () => selectorConfig.listSessions())
      );
      if (result === EXIT_REQUESTED) {
        return;
      }
      sessions = result;
    } catch (error) {
      clearStatus();
      showSystemMessage(
        `Could not list sessions: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      tui.requestRender();
      return;
    }
    clearStatus();
    if (sessions.length === 0) {
      showSystemMessage("No sessions recorded yet.");
      tui.requestRender();
      return;
    }

    const resumeBusy = busy.suspend();
    const pendingSelection = new Promise<string | undefined>((resolve) => {
      commandInputListenerActive = true;
      let selector: SessionSelectorComponent | undefined;
      let settled = false;
      const settle = (sessionKey: string | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        extensionUiController.signal.removeEventListener("abort", abort);
        commandInputListenerActive = false;
        if (activeSessionSelector === selector) {
          activeSessionSelector = undefined;
        }
        composerLayer.setContent(editor);
        tui.setFocus(composerLayer);
        tui.requestRender();
        resumeBusy();
        resolve(sessionKey);
      };
      // Exit must settle the selector through the same idempotent path as
      // Escape; otherwise it stays mounted with input capture still active
      // after the TUI has stopped.
      const abort = () => settle(undefined);
      extensionUiController.signal.addEventListener("abort", abort, {
        once: true,
      });
      const layout = getModelSelectorLayout();
      selector = new SessionSelectorComponent({
        compact: layout.compact,
        currentSessionKey: selectorConfig.currentSessionKey(),
        ...(initialQuery === undefined ? {} : { initialQuery }),
        maxVisibleSessions: layout.maxVisibleModels,
        onCancel: () => settle(undefined),
        onSelect: (sessionKey) => settle(sessionKey),
        sessions,
      });
      activeSessionSelector = selector;
      composerLayer.setContent(selector);
      tui.setFocus(composerLayer);
      tui.requestRender();
    });
    const selection = await untilExit(pendingSelection);

    if (
      selection === undefined ||
      selection === EXIT_REQUESTED ||
      selection === selectorConfig.currentSessionKey()
    ) {
      return;
    }
    try {
      await busy.run("Switching session...", async () => {
        await renderSessionHistory(
          await resumeSessionReplayParts(selectorConfig, selection)
        );
      });
      updateHeader();
    } catch (error) {
      showSystemMessage(
        `Session switch failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    tui.requestRender();
  };

  const showActionlessCommandResult = (
    commandResult: TuiCommandResult | null
  ): void => {
    if (commandResult?.message) {
      showSystemMessage(commandResult.message);
    } else if (commandResult === null) {
      showSystemMessage("Unknown command.");
    }
    tui.requestRender();
  };

  const handleCommandResult = async (
    commandResult: TuiCommandResult | null
  ): Promise<void> => {
    if (!(commandResult?.success && commandResult.action)) {
      showActionlessCommandResult(commandResult);
      return;
    }

    if (commandResult.action.type === "new-session") {
      showActionlessCommandResult(commandResult);
      return;
    }

    if (commandResult.action.type === "reload") {
      await handleReloadAction(commandResult);
      return;
    }

    if (commandResult.action.type === "select-model") {
      await showModelSelector(commandResult.action.query);
      return;
    }

    if (commandResult.action.type === "select-session") {
      await showSessionSelector(commandResult.action.query);
      return;
    }

    if (commandResult.action.type === "submit-prompt") {
      // Prompt-template commands expand into a normal user turn.
      await processUserInputMessage(commandResult.action.prompt);
      return;
    }

    if (commandResult.action.type === "session") {
      await handleSessionAction(commandResult, commandResult.action.clear);
      return;
    }

    if (commandResult.action.type === "refresh-header") {
      const action = commandResult.action;
      await busy.run("Working...", () => config.onCommandAction?.(action));
      updateHeader();
    }

    if (commandResult.message) {
      showSystemMessage(commandResult.message);
    }
    tui.requestRender();
  };

  const handleSessionAction = async (
    commandResult: TuiCommandResult,
    clear: boolean
  ): Promise<void> => {
    if (clear) {
      clearStatus();
      await renderSessionHistory();
    }
    updateHeader();
    if (commandResult.message) {
      showSystemMessage(commandResult.message);
    }
    tui.requestRender();
  };

  const handleReloadAction = async (
    commandResult: TuiCommandResult
  ): Promise<void> => {
    if (!commandResult.action) {
      return;
    }
    const action = commandResult.action;
    try {
      await busy.run("Reloading...", () => config.onCommandAction?.(action));
    } catch (error) {
      refreshCommandSet();
      showSystemMessage(
        `Reload failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      tui.requestRender();
      return;
    }
    refreshCommandSet();
    updateHeader();
    if (commandResult.message) {
      showSystemMessage(commandResult.message);
    }
    tui.requestRender();
  };

  const processCommandInput = (trimmed: string): Promise<boolean> =>
    busy.run("Working...", async () => {
      const commandInput = await preprocessCommandInput(trimmed);
      if (commandInput === null) {
        tui.requestRender();
        return true;
      }

      const commandResult = await executeLocalCommand(commandInput);
      await handleCommandResult(commandResult);
      return true;
    });

  const processUserInputMessage = (
    trimmed: string,
    steeringRun?: AgentTurn
  ): Promise<void> =>
    busy.run(
      steeringRun === undefined ? "Processing..." : "Steering...",
      async () => {
        addUserMessage(chatContainer, markdownTheme, trimmed);
        tui.requestRender();

        const result = await dispatchUserInput({
          activeRun: steeringRun,
          hooks: {
            showStatus: (text: string) => showLoader(text),
            clearStatus: () => clearStatus(),
          },
          input: trimmed,
          onPrepared: (prepared) => {
            if (prepared.translatedDisplay) {
              addTranslatedMessage(
                chatContainer,
                markdownTheme,
                prepared.translatedDisplay
              );
            }
            showLoader(
              steeringRun === undefined ? "Processing..." : "Steering..."
            );
            tui.requestRender();
          },
          preprocess: config.preprocessUserInput,
          thread: config.thread,
        });

        if (result.type === "rejected") {
          clearStatus();
          showSystemMessage(result.error);
          tui.requestRender();
          return;
        }

        if (!result.consumeRun) {
          clearStatus();
          return;
        }

        await runSingleTurn(result.run);
      }
    );

  const processSteeringInput = async (
    trimmed: string,
    steeringRun: AgentTurn
  ): Promise<void> => {
    editor.disableSubmit = true;
    editor.setText("");
    tui.requestRender();
    try {
      await processUserInputMessage(trimmed, steeringRun);
    } finally {
      editor.disableSubmit = false;
      tui.setFocus(composerLayer);
      tui.requestRender();
    }
  };

  const processInput = async (input: string): Promise<boolean> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      showSystemMessage("Please enter a message.");
      tui.requestRender();
      return true;
    }

    try {
      editor.disableSubmit = true;
      editor.setText("");
      tui.requestRender();

      if (isCommand(trimmed)) {
        return await processCommandInput(trimmed);
      }

      await processUserInputMessage(trimmed);
      return true;
    } catch (error) {
      clearStatus();
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      showSystemMessage(`Error: ${errorMessage}`);
      tui.requestRender();
      return true;
    } finally {
      editor.disableSubmit = false;
      tui.setFocus(composerLayer);
      tui.requestRender();
    }
  };

  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      editor.addToHistory(trimmed);
    }

    const steeringTurn = session.activeTurn;
    if (steeringTurn !== undefined) {
      if (trimmed.length > 0) {
        const parsed = parseCommand(trimmed);
        const activeCommand =
          parsed === null
            ? undefined
            : resolveTuiCommand(commandSet, parsed.name);
        const operation =
          activeCommand?.allowDuringActiveTurn === true
            ? (async () => {
                editor.disableSubmit = true;
                editor.setText("");
                try {
                  await processCommandInput(trimmed);
                } finally {
                  editor.disableSubmit = false;
                  tui.setFocus(composerLayer);
                  tui.requestRender();
                }
              })()
            : processSteeringInput(trimmed, steeringTurn.run);
        operation.catch((error: unknown) => {
          clearStatus();
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          showSystemMessage(`Error: ${errorMessage}`);
          tui.requestRender();
        });
      }
      return;
    }

    session.submitInput(text);
  };

  updateHeader();
  tui.start();

  try {
    await busy.run("Activating extensions...", () =>
      config.onExtensionUiReady?.((hostSignal) =>
        createExtensionUi({
          restoreFocus: clearPromptInput,
          showMessage: showSystemMessage,
          showStatus: (message) => {
            const clear = busy.status(message);
            const signal = hostSignal ?? extensionUiController.signal;
            signal.addEventListener("abort", clear, {
              once: true,
            });
            if (signal.aborted) {
              clear();
            }
            return () => {
              signal.removeEventListener("abort", clear);
              clear();
            };
          },
          onUserWait: () => busy.suspend(),
          // Host-scoped signals let a runtime swap cancel prompts that a
          // detached previous host still has on screen.
          signal:
            hostSignal === undefined
              ? extensionUiController.signal
              : AbortSignal.any([extensionUiController.signal, hostSignal]),
          tui,
        })
      )
    );
    for (const message of config.setupMessages ?? []) {
      showSystemMessage(message);
    }
    await busy.run("Setting up...", () => config.onSetup?.());
    if (config.replayHistoryOnStartup === true) {
      await renderSessionHistory();
    }
    updateHeader();

    while (!session.closed) {
      const input = await waitForInput();
      if (input === null) {
        break;
      }

      const shouldContinue = await processInput(input);
      if (!shouldContinue) {
        break;
      }
    }
  } finally {
    extensionUiController.abort();
    busy.dispose();
    footerStatusBar.stop();
    session.close();

    removeInputListener();
    process.stdout.off("resize", onTerminalResize);
    process.off("SIGINT", onSigInt);

    try {
      await terminal.drainInput();
    } finally {
      // Rendering must stop before the streamed assistant views are disposed:
      // disposal empties their children, so a later render would blank the
      // reply that is already on screen.
      try {
        // Flush the final interruption/status frame while its views still
        // exist. Normal stop adds a clamped cursor move and newline, losing
        // the composer's position when the transcript fills the viewport.
        // Ending a pulse first keeps an exit mid-blink from freezing the
        // notice inverted in that preserved frame.
        repeatedNotice.settle();
        tui.renderNow();
        const renderState = tui.captureRenderState();
        const composerRows = composerLayer.render(terminal.columns).length;
        tui.stop({ preserveScreen: true });
        terminal.write(terminalExitCursorSequence(renderState, composerRows));
        disposeAssistantViews();
      } finally {
        repeatedNotice.stop();
        await Promise.all(turnCompletions);
        for (const error of completionFailures) {
          console.error("onTurnComplete callback failed in TUI:", error);
        }
      }
    }
  }
}
