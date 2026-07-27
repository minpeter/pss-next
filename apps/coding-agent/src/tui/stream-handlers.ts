import {
  type Container,
  type Markdown,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { AssistantStreamView } from "./stream-views";
import { sanitizeTerminalText } from "./terminal-safety";
import type { ToolCallView } from "./tool-call-view";

/**
 * Stream-part shape consumed by the TUI dispatch table. This mirrors the AI
 * SDK `fullStream` part union the plugsuits TUI rendered; pss-runtime agent
 * events are translated into these parts by `tui-agent-event-stream`.
 */
export interface TuiStreamPart {
  type: string;
  [key: string]: unknown;
}

const getToolInputId = (part: {
  id?: string;
  toolCallId?: string;
}): string | undefined => part.id ?? part.toolCallId;

const getToolInputChunk = (part: {
  delta?: unknown;
  inputTextDelta?: unknown;
}): string | null => {
  if (typeof part.delta === "string") {
    return part.delta;
  }

  if (typeof part.inputTextDelta === "string") {
    return part.inputTextDelta;
  }

  return null;
};

export interface ToolInputRenderState {
  hasContent: boolean;
  inputBuffer: string;
  renderedInputLength: number;
  toolName: string;
}

const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return sanitizeTerminalText(value);
  }

  try {
    return sanitizeTerminalText(JSON.stringify(value, null, 2));
  } catch {
    return sanitizeTerminalText(String(value));
  }
};

export const UNKNOWN_TOOL_NAME = "tool";

export const addChatComponent = (
  chatContainer: Container,
  component: Container | Text | Markdown,
  options: { addLeadingSpacer?: boolean } = {}
): void => {
  if (options.addLeadingSpacer ?? true) {
    chatContainer.addChild(new Spacer(1));
  }

  chatContainer.addChild(component);
};

export const createToolInputState = (
  toolName: string
): ToolInputRenderState => ({
  toolName,
  hasContent: false,
  inputBuffer: "",
  renderedInputLength: 0,
});

export interface PiTuiRenderFlags {
  showFiles: boolean;
  showFinishReason: boolean;
  showRawToolIo: boolean;
  showReasoning: boolean;
  showSources: boolean;
  showSteps: boolean;
  showToolResults: boolean;
}

export interface PiTuiStreamState {
  activeToolInputs: Map<string, ToolInputRenderState>;
  chatContainer: Container;
  ensureAssistantView: () => AssistantStreamView;
  ensureToolView: (toolCallId: string, toolName: string) => ToolCallView;
  flags: PiTuiRenderFlags;
  getToolView: (toolCallId: string) => ToolCallView | undefined;
  onReasoningEnd?: () => void;
  onReasoningStart?: () => void;
  onToolPendingEnd?: () => void;
  onToolPendingStart?: () => void;
  pendingToolCallIds: Set<string>;
  resetAssistantView: (suppressLeadingSpacer?: boolean) => void;
  streamedToolCallIds: Set<string>;
}

export const syncToolInputToView = async (
  state: PiTuiStreamState,
  toolCallId: string,
  toolState: ToolInputRenderState
): Promise<void> => {
  const hasKnownToolName = toolState.toolName !== UNKNOWN_TOOL_NAME;
  if (!(state.flags.showRawToolIo || hasKnownToolName)) {
    return;
  }

  const existingView = state.getToolView(toolCallId);
  const pendingInput = toolState.inputBuffer.slice(
    toolState.renderedInputLength
  );
  if (!existingView && pendingInput.length === 0) {
    return;
  }

  state.resetAssistantView(true);
  const toolView =
    existingView ?? state.ensureToolView(toolCallId, toolState.toolName);

  if (pendingInput.length === 0) {
    return;
  }

  await toolView.appendInputChunk(pendingInput);
  toolState.renderedInputLength = toolState.inputBuffer.length;
};

export const createInfoMessage = (title: string, value: unknown): Text =>
  new Text(`${title}\n${safeStringify(value)}`, 1, 0);

export type StreamPartHandler = (
  part: TuiStreamPart,
  state: PiTuiStreamState
) => void | Promise<void>;

export const handleTextStart: StreamPartHandler = (_part, state) => {
  state.ensureAssistantView();
};

export const handleTextDelta: StreamPartHandler = (part, state) => {
  state.ensureAssistantView().appendText(String(part.text ?? ""));
};

export const handleReasoningStart: StreamPartHandler = (_part, state) => {
  if (state.flags.showReasoning) {
    state.ensureAssistantView();
  }
  state.onReasoningStart?.();
};

export const handleReasoningDelta: StreamPartHandler = (part, state) => {
  if (!state.flags.showReasoning) {
    return;
  }

  state.ensureAssistantView().appendReasoning(String(part.text ?? ""));
};

export const handleReasoningEnd: StreamPartHandler = (_part, state) => {
  state.onReasoningEnd?.();
};

export const handleToolInputStart: StreamPartHandler = async (part, state) => {
  const toolCallId = getToolInputId(
    part as { id?: string; toolCallId?: string }
  );
  if (!toolCallId) {
    return;
  }

  const existingState = state.activeToolInputs.get(toolCallId);
  const toolState =
    existingState ?? createToolInputState(String(part.toolName ?? ""));
  toolState.toolName = String(part.toolName ?? "");

  state.activeToolInputs.set(toolCallId, toolState);
  state.streamedToolCallIds.add(toolCallId);
  await syncToolInputToView(state, toolCallId, toolState);
};

export const handleToolInputDelta: StreamPartHandler = async (part, state) => {
  const toolCallId = getToolInputId(
    part as { id?: string; toolCallId?: string }
  );
  if (!toolCallId) {
    return;
  }

  if (!state.activeToolInputs.has(toolCallId)) {
    state.activeToolInputs.set(
      toolCallId,
      createToolInputState(UNKNOWN_TOOL_NAME)
    );
  }

  const toolState = state.activeToolInputs.get(toolCallId);
  const chunk = getToolInputChunk(
    part as { delta?: unknown; inputTextDelta?: unknown }
  );

  if (chunk && toolState) {
    toolState.inputBuffer += chunk;
    toolState.hasContent = true;
    await syncToolInputToView(state, toolCallId, toolState);
  }

  state.streamedToolCallIds.add(toolCallId);
};

export const handleToolInputEnd: StreamPartHandler = (part, state) => {
  const toolCallId = getToolInputId(
    part as { id?: string; toolCallId?: string }
  );
  if (toolCallId) {
    state.streamedToolCallIds.add(toolCallId);
  }
};

const firePendingEndIfTracked = (
  state: PiTuiStreamState,
  toolCallId: string
): void => {
  if (!state.pendingToolCallIds.delete(toolCallId)) {
    return;
  }
  state.onToolPendingEnd?.();
};

export const handleToolCall: StreamPartHandler = (part, state) => {
  const toolCallId = String(part.toolCallId ?? "");
  const toolName = String(part.toolName ?? "");
  const inputState = state.activeToolInputs.get(toolCallId);
  const shouldSkipToolCallRender =
    state.streamedToolCallIds.has(toolCallId) &&
    inputState?.hasContent === true;

  state.activeToolInputs.delete(toolCallId);
  state.streamedToolCallIds.delete(toolCallId);

  state.resetAssistantView(true);
  const view = state.ensureToolView(toolCallId, toolName);
  view.setFinalInput(part.input);

  if (!shouldSkipToolCallRender) {
    view.setToolName(toolName);
  }

  if (!state.pendingToolCallIds.has(toolCallId)) {
    state.pendingToolCallIds.add(toolCallId);
    state.onToolPendingStart?.();
  }
};

export const handleToolResult: StreamPartHandler = (part, state) => {
  const toolCallId = String(part.toolCallId ?? "");
  const toolName = String(part.toolName ?? "");
  firePendingEndIfTracked(state, toolCallId);

  if (!state.flags.showToolResults) {
    return;
  }

  state.resetAssistantView(true);
  const view = state.ensureToolView(toolCallId, toolName);
  view.setOutput(part.output);
};

export const handleToolError: StreamPartHandler = (part, state) => {
  const toolCallId = String(part.toolCallId ?? "");
  const toolName = String(part.toolName ?? "");
  firePendingEndIfTracked(state, toolCallId);
  state.resetAssistantView(true);
  const view = state.ensureToolView(toolCallId, toolName);
  view.setError(part.error);
};

export const handleToolOutputDenied: StreamPartHandler = (part, state) => {
  const toolCallId = String(part.toolCallId ?? "");
  const toolName = String(part.toolName ?? "");
  firePendingEndIfTracked(state, toolCallId);
  state.resetAssistantView(true);
  const view = state.ensureToolView(toolCallId, toolName);
  view.setOutputDenied(
    typeof part.reason === "string" ? part.reason : undefined
  );
};

export const handleToolApprovalRequest: StreamPartHandler = (part, state) => {
  const approvalPart = part as TuiStreamPart & {
    providerExecuted?: boolean;
    reason?: string;
    toolCallId: string;
    toolName: string;
  };

  firePendingEndIfTracked(state, approvalPart.toolCallId);
  state.resetAssistantView(true);
  const view = state.ensureToolView(
    approvalPart.toolCallId,
    approvalPart.toolName
  );

  const lines = [
    `**Tool** \`${approvalPart.toolName}\` (\`${approvalPart.toolCallId}\`)`,
    "**Approval required** before this tool can continue.",
  ];

  if (
    typeof approvalPart.reason === "string" &&
    approvalPart.reason.length > 0
  ) {
    lines.push(`**Reason** ${approvalPart.reason}`);
  }

  if (approvalPart.providerExecuted === false) {
    lines.push("**Status** waiting for user or policy decision");
  }

  view.setPrettyBlock(
    `**Approval** \`${approvalPart.toolName}\``,
    lines.join("\n\n")
  );
};

export const handleStartStep: StreamPartHandler = (_part, state) => {
  if (!state.flags.showSteps) {
    return;
  }

  state.resetAssistantView();
  addChatComponent(state.chatContainer, createInfoMessage("[step start]", ""));
};

export const handleFinishStep: StreamPartHandler = (part, state) => {
  if (!state.flags.showSteps) {
    return;
  }

  state.resetAssistantView();
  addChatComponent(
    state.chatContainer,
    createInfoMessage("[step finish]", part.finishReason)
  );
};

export const handleSource: StreamPartHandler = (part, state) => {
  if (!state.flags.showSources) {
    return;
  }

  state.resetAssistantView();
  addChatComponent(state.chatContainer, createInfoMessage("[source]", part));
};

export const handleFile: StreamPartHandler = (part, state) => {
  if (!state.flags.showFiles) {
    return;
  }

  state.resetAssistantView();
  addChatComponent(state.chatContainer, createInfoMessage("[file]", part.file));
};

export const handleFinish: StreamPartHandler = (part, state) => {
  if (!state.flags.showFinishReason) {
    return;
  }

  state.resetAssistantView();
  addChatComponent(
    state.chatContainer,
    createInfoMessage("[finish]", part.finishReason ?? "unknown")
  );
};

export const STREAM_HANDLERS: Record<string, StreamPartHandler> = {
  "text-start": handleTextStart,
  "text-delta": handleTextDelta,
  "reasoning-start": handleReasoningStart,
  "reasoning-delta": handleReasoningDelta,
  "reasoning-end": handleReasoningEnd,
  "tool-input-start": handleToolInputStart,
  "tool-input-delta": handleToolInputDelta,
  "tool-input-end": handleToolInputEnd,
  "tool-call": handleToolCall,
  "tool-result": handleToolResult,
  "tool-error": handleToolError,
  "tool-output-denied": handleToolOutputDenied,
  "tool-approval-request": handleToolApprovalRequest,
  "start-step": handleStartStep,
  "finish-step": handleFinishStep,
  source: handleSource,
  file: handleFile,
  finish: handleFinish,
};

export const IGNORE_PART_TYPES = new Set(["abort", "text-end", "start"]);

export const isVisibleStreamPart = (
  part: TuiStreamPart,
  flags: PiTuiRenderFlags
): boolean => {
  switch (part.type) {
    case "abort":
    case "text-end":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "start":
    case "tool-input-end":
      return false;
    case "text-start":
      return true;
    case "tool-result":
      return flags.showToolResults;
    case "start-step":
    case "finish-step":
      return flags.showSteps;
    case "source":
      return flags.showSources;
    case "file":
      return flags.showFiles;
    case "finish":
      return flags.showFinishReason;
    default:
      return true;
  }
};
