import {
  Container,
  Editor,
  type EditorTheme,
  isKeyRelease,
  isKeyRepeat,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentTurn, ModelUsage } from "@minpeter/pss-runtime";
import type { CodingAgentExtensionUi } from "../extensions/types";
import { agentEventStreamParts } from "./agent-event-stream";
import { createAliasAwareAutocompleteProvider } from "./autocomplete";
import {
  isCommand,
  parseCommand,
  type TuiCommand,
  type TuiCommandAction,
  type TuiCommandResult,
} from "./command";
import { buildTuiCommandSet } from "./command-set";
import { createTuiErrorPresentation } from "./error-presentation";
import { createExtensionUi } from "./extension-ui";
import {
  dispatchUserInput,
  type InputPreprocessHooks,
  type InputPreprocessResult,
  type InputThread,
} from "./input-routing";
import { createSpinnerTicker, type SpinnerTicker } from "./pending-spinner";
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
import { sanitizeTerminalText } from "./terminal-safety";
import { BaseToolCallView, type ToolRendererMap } from "./tool-call-view";

const ANSI_RESET = "\x1b[0m";
const ANSI_BLACK = "\x1b[30m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_BG_SOFT_LIGHT = "\x1b[48;5;249m";
const ANSI_BG_GRAY = "\x1b[100m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BRIGHT_CYAN = "\x1b[96m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const CTRL_C_ETX = "\u0003";
const CTRL_C_EXIT_WINDOW_MS = 500;

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
    return this.entries[0];
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
      return [];
    }

    const contentWidth = Math.max(0, width - 1);
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

    const remainingEntries =
      this.foregroundMessage === null ? this.entries.slice(1) : this.entries;
    for (const entry of remainingEntries) {
      const left = this.renderLeftEntry(entry, contentWidth);
      lines.push(this.padLine(` ${left.styled}`, width));
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
      ` ${left?.styled ?? ""}${" ".repeat(gap)}${rightTextStyled}`,
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
        ? `${prefixStyle}${message ? ` ${style(messageStylePrefix, message)}` : ""}`
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

const addSystemMessage = (chatContainer: Container, message: string): void => {
  const cleaned = sanitizeTerminalText(message).trimEnd();
  if (cleaned.length === 0) {
    return;
  }

  addChatComponent(chatContainer, new Text(style(ANSI_GRAY, cleaned), 1, 0));
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

const addNewSessionMessage = (chatContainer: Container): void => {
  addChatComponent(
    chatContainer,
    new Text(style(ANSI_BRIGHT_CYAN, "✓ New session started"), 1, 0)
  );
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
  chatContainer: Container;
  flags: PiTuiRenderFlags;
  markdownTheme: MarkdownTheme;
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
      assistantView = new AssistantStreamView(options.markdownTheme);
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
  commands?: TuiCommand[];
  footer?: { text?: string };
  header?: { title: string; subtitle?: string };
  onCommandAction?: (action: TuiCommandAction) => void | Promise<void>;
  onExtensionUiReady?: (
    createUi: (hostSignal?: AbortSignal) => CodingAgentExtensionUi
  ) => void | Promise<void>;
  onModelUsage?: (usage: ModelUsage) => void;
  /**
   * Receives streamed output text fragments (assistant text, reasoning,
   * tool-call input) so the host can estimate token usage live between
   * authoritative `onModelUsage` calls.
   */
  onOutputDelta?: (text: string) => void;
  onSetup?: () => void | Promise<void>;
  onStreamStart?: () => void | Promise<void>;
  onTurnComplete?: (
    usage: TurnUsage | undefined,
    finishReason?: string
  ) => Promise<void> | void;
  preprocessCommand?: (
    commandInput: string,
    hooks: CommandPreprocessHooks
  ) => Promise<string | null>;
  preprocessUserInput?: (
    input: string,
    hooks: PreprocessHooks
  ) => Promise<PreprocessResult | undefined>;
  setupMessages?: string[];
  showRawToolIo?: boolean;
  theme?: { markdownTheme?: MarkdownTheme; editorTheme?: EditorTheme };
  thread: TuiThread;
  toolRenderers?: ToolRendererMap;
}

export async function createAgentTUI(config: AgentTUIConfig): Promise<void> {
  const markdownTheme =
    config.theme?.markdownTheme ?? createDefaultMarkdownTheme();
  const editorTheme = config.theme?.editorTheme ?? createDefaultEditorTheme();
  let commandSet = buildTuiCommandSet(config.commands);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  tui.setClearOnShrink(false);

  const headerContainer = new Container();
  const chatContainer = new Container();
  const overlayContainer = new Container();
  const editorContainer = new Container();
  const footerContainer = new Container();
  const footerStatusBar = new FooterStatusBar(tui);

  const title = new Text("", 1, 0);
  const help = new Text(
    style(
      ANSI_DIM,
      "Enter to submit, Shift+Enter for newline, /help for commands, Esc to interrupt, Ctrl+C to clear, Ctrl+C twice to exit"
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
        ? `${style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)}\n${style(ANSI_DIM, subtitle)}`
        : style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)
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
  const refreshCommandSet = (): void => {
    commandSet = buildTuiCommandSet(config.commands);
    editor.setAutocompleteProvider(
      createAliasAwareAutocompleteProvider({
        commands: commandSet.commands,
        basePath: process.cwd(),
      })
    );
  };
  editor.setAutocompleteProvider(
    createAliasAwareAutocompleteProvider({
      commands: commandSet.commands,
      basePath: process.cwd(),
    })
  );
  editorContainer.addChild(editor);
  footerContainer.addChild(footerStatusBar);

  tui.addChild(headerContainer);
  tui.addChild(chatContainer);
  tui.addChild(overlayContainer);
  tui.addChild(editorContainer);
  tui.addChild(footerContainer);
  tui.setFocus(editor);

  let shouldExit = false;
  let activeTurnInterrupted = false;
  let activeRun: AgentTurn | undefined;
  let inputResolver: null | ((value: string | null) => void) = null;
  let lastCtrlCPressAt = 0;
  let foregroundStatusMessage: string | null = null;
  let commandInputListenerActive = false;
  const extensionUiController = new AbortController();

  const clearStatus = (): void => {
    foregroundStatusMessage = null;
    footerStatusBar.setForegroundMessage(null);
  };

  const showLoader = (message: string): void => {
    const sanitized = sanitizeTerminalText(message);
    foregroundStatusMessage = sanitized;
    footerStatusBar.setForegroundMessage(sanitized);
  };

  const clearPromptInput = (): void => {
    editor.setText("");
    tui.setFocus(editor);
    tui.requestRender();
  };

  const cancelActiveTurn = (): boolean => {
    if (activeRun === undefined) {
      return false;
    }

    activeTurnInterrupted = true;
    config.thread.interrupt();
    return true;
  };

  const requestExit = (): void => {
    shouldExit = true;
    extensionUiController.abort();
    cancelActiveTurn();
    clearStatus();
    if (inputResolver) {
      const resolve = inputResolver;
      inputResolver = null;
      resolve(null);
    }
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
    if (now - lastCtrlCPressAt < CTRL_C_EXIT_WINDOW_MS) {
      requestExit();
      return;
    }

    clearPromptInput();
    lastCtrlCPressAt = now;
  };

  const onTerminalResize = (): void => {
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
      activeRun !== undefined
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
      inputResolver = (value: string | null) => resolve(value);
      tui.setFocus(editor);
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
      chatContainer,
      flags,
      markdownTheme,
      requestRender: () => tui.requestRender(),
      toolRenderers: config.toolRenderers,
    });
    const tracker: StreamPartTracker = {
      finishReason: undefined,
      firstVisiblePartSeen: false,
    };

    const baseLoaderMessage = loaderMessage ?? foregroundStatusMessage;
    const orchestrator = createSpinnerOrchestrator(
      {
        clearStatus,
        hasSpinner: () => foregroundStatusMessage !== null,
        setMessage: (message) => {
          foregroundStatusMessage = message;
          footerStatusBar.setForegroundMessage(message);
        },
        showLoader,
      },
      baseLoaderMessage
    );

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
      onToolPendingStart: orchestrator.onToolPendingStart,
      onToolPendingEnd: orchestrator.onToolPendingEnd,
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
      for (const view of toolViews.values()) {
        view.dispose();
      }
    }

    return { finishReason: tracker.finishReason };
  };

  const createStreamingLoaderClearer = (): (() => void) => {
    let hasClearedStreamingLoader = false;

    return () => {
      if (hasClearedStreamingLoader) {
        return;
      }
      hasClearedStreamingLoader = true;
      clearStatus();
    };
  };

  const accumulateUsage = (
    total: { inputTokens: number; outputTokens: number; totalTokens: number },
    usage: ModelUsage
  ): void => {
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.totalTokens +=
      usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  };

  const runSingleTurn = async (run: AgentTurn): Promise<void> => {
    activeRun = run;
    activeTurnInterrupted = false;
    editor.disableSubmit = false;
    tui.setFocus(editor);

    const turnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let sawModelUsage = false;

    try {
      showLoader("Working...");
      try {
        await config.onStreamStart?.();
      } catch (hookError) {
        console.error("[tui] onStreamStart threw; continuing turn:", hookError);
      }

      const clearStreamingLoader = createStreamingLoaderClearer();

      const { finishReason } = await renderAgentStream(
        agentEventStreamParts(run.events(), {
          onModelUsage: (usage) => {
            sawModelUsage = true;
            accumulateUsage(turnUsage, usage);
            config.onModelUsage?.(usage);
            updateHeader();
          },
          ...(config.onOutputDelta === undefined
            ? {}
            : {
                onOutputDelta: (text: string) => {
                  config.onOutputDelta?.(text);
                  updateHeader();
                },
              }),
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
        clearStreamingLoader,
        "Working..."
      );

      clearStreamingLoader();

      if (activeTurnInterrupted) {
        addInterruptedMessage();
        return;
      }

      Promise.resolve(
        config.onTurnComplete?.(
          sawModelUsage ? { ...turnUsage } : undefined,
          finishReason
        )
      ).catch((error) => {
        console.error("onTurnComplete callback failed in TUI:", error);
      });

      if (finishReason !== undefined) {
        addAbnormalFinishReasonMessage(finishReason);
      }
    } finally {
      if (activeRun === run) {
        activeRun = undefined;
      }
      activeTurnInterrupted = false;
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

    const normalizedName = parsed.name.toLowerCase();
    const resolvedName =
      commandSet.commandAliasLookup.get(normalizedName) ?? normalizedName;
    const command = commandSet.commandLookup.get(resolvedName);
    if (!command) {
      return null;
    }

    return await command.execute({ args: parsed.args });
  };

  const preprocessCommandInput = async (
    input: string
  ): Promise<string | null> => {
    if (!config.preprocessCommand) {
      return input;
    }

    return await config.preprocessCommand(input, {
      addInputListener: (listener) => {
        commandInputListenerActive = true;
        const remove = tui.addInputListener(listener);
        return () => {
          remove();
          commandInputListenerActive = false;
        };
      },
      clearStatus,
      tui,
      overlayContainer,
      editorTheme,
      isCtrlCInput,
      handleCtrlCPress,
      showMessage: (message: string) =>
        addSystemMessage(chatContainer, message),
      updateHeader,
    });
  };

  const handleNewSessionAction = async (
    commandResult: TuiCommandResult
  ): Promise<void> => {
    if (!commandResult.action) {
      return;
    }

    clearStatus();
    chatContainer.clear();
    addNewSessionMessage(chatContainer);
    await config.onCommandAction?.(commandResult.action);
    updateHeader();

    if (commandResult.message) {
      addSystemMessage(chatContainer, commandResult.message);
    }
    tui.requestRender();
  };

  const handleCommandResult = async (
    commandResult: TuiCommandResult | null
  ): Promise<void> => {
    if (!(commandResult?.success && commandResult.action)) {
      if (commandResult?.message) {
        addSystemMessage(chatContainer, commandResult.message);
      } else if (commandResult === null) {
        addSystemMessage(chatContainer, "Unknown command. Try /help");
      }
      tui.requestRender();
      return;
    }

    if (commandResult.action.type === "new-session") {
      await handleNewSessionAction(commandResult);
      return;
    }

    if (commandResult.action.type === "reload") {
      await handleReloadAction(commandResult);
      return;
    }

    if (commandResult.message) {
      addSystemMessage(chatContainer, commandResult.message);
    }
    tui.requestRender();
  };

  const handleReloadAction = async (
    commandResult: TuiCommandResult
  ): Promise<void> => {
    if (!commandResult.action) {
      return;
    }
    try {
      await config.onCommandAction?.(commandResult.action);
    } catch (error) {
      refreshCommandSet();
      addSystemMessage(
        chatContainer,
        `Reload failed: ${error instanceof Error ? error.message : String(error)}`
      );
      tui.requestRender();
      return;
    }
    refreshCommandSet();
    updateHeader();
    if (commandResult.message) {
      addSystemMessage(chatContainer, commandResult.message);
    }
    tui.requestRender();
  };

  const processCommandInput = async (trimmed: string): Promise<boolean> => {
    const commandInput = await preprocessCommandInput(trimmed);
    if (commandInput === null) {
      tui.requestRender();
      return true;
    }

    const commandResult = await executeLocalCommand(commandInput);
    await handleCommandResult(commandResult);
    return true;
  };

  const processUserInputMessage = async (
    trimmed: string,
    steeringRun?: AgentTurn
  ): Promise<void> => {
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
        showLoader(steeringRun === undefined ? "Processing..." : "Steering...");
        tui.requestRender();
      },
      preprocess: config.preprocessUserInput,
      thread: config.thread,
    });

    if (result.type === "rejected") {
      clearStatus();
      addSystemMessage(chatContainer, result.error);
      tui.requestRender();
      return;
    }

    if (!result.consumeRun) {
      clearStatus();
      return;
    }

    await runSingleTurn(result.run);
  };

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
      tui.setFocus(editor);
      tui.requestRender();
    }
  };

  const processInput = async (input: string): Promise<boolean> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      addSystemMessage(chatContainer, "메시지를 입력해주세요");
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
      addSystemMessage(chatContainer, `Error: ${errorMessage}`);
      tui.requestRender();
      return true;
    } finally {
      editor.disableSubmit = false;
      tui.setFocus(editor);
      tui.requestRender();
    }
  };

  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      editor.addToHistory(trimmed);
    }

    const steeringRun = activeRun;
    if (steeringRun !== undefined) {
      if (trimmed.length > 0) {
        processSteeringInput(trimmed, steeringRun).catch((error: unknown) => {
          clearStatus();
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          addSystemMessage(chatContainer, `Error: ${errorMessage}`);
          tui.requestRender();
        });
      }
      return;
    }

    if (!inputResolver) {
      return;
    }

    const resolve = inputResolver;
    inputResolver = null;
    resolve(text);
  };

  updateHeader();
  tui.start();

  try {
    await config.onExtensionUiReady?.((hostSignal) =>
      createExtensionUi({
        restoreFocus: clearPromptInput,
        showMessage: (message) => addSystemMessage(chatContainer, message),
        showStatus: (message) => {
          showLoader(message);
          return clearStatus;
        },
        // Host-scoped signals let a runtime swap cancel prompts that a
        // detached previous host still has on screen.
        signal:
          hostSignal === undefined
            ? extensionUiController.signal
            : AbortSignal.any([extensionUiController.signal, hostSignal]),
        tui,
      })
    );
    for (const message of config.setupMessages ?? []) {
      addSystemMessage(chatContainer, message);
    }
    await config.onSetup?.();
    updateHeader();

    while (!shouldExit) {
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
    clearStatus();
    footerStatusBar.stop();
    const pendingResolver: unknown = inputResolver;
    inputResolver = null;
    if (typeof pendingResolver === "function") {
      pendingResolver(null);
    }

    removeInputListener();
    process.stdout.off("resize", onTerminalResize);
    process.off("SIGINT", onSigInt);

    try {
      await terminal.drainInput();
    } finally {
      tui.stop();
    }
  }
}
