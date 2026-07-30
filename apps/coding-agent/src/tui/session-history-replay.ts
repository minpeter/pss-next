import type {
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from "ai";
import type { TuiStreamPart } from "./stream-handlers";

export type SessionHistoryReplayPart =
  | { readonly type: "clear" }
  | { readonly text: string; readonly type: "user" }
  | { readonly part: TuiStreamPart; readonly type: "stream" };

const stream = (part: TuiStreamPart): SessionHistoryReplayPart => ({
  part,
  type: "stream",
});

const textStream = (
  type: "reasoning" | "text",
  text: string
): readonly SessionHistoryReplayPart[] => [
  stream({ type: `${type}-start` }),
  stream({ text, type: `${type}-delta` }),
  stream({ type: `${type}-end` }),
];

const toolResultOutput = (output: unknown): unknown => {
  if (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    "value" in output &&
    (output.type === "text" || output.type === "json")
  ) {
    return output.value;
  }
  return output;
};

type ReplayContentPart =
  | Exclude<AssistantModelMessage["content"], string>[number]
  | ToolModelMessage["content"][number];

const replayContentPart = (
  part: ReplayContentPart
): readonly SessionHistoryReplayPart[] => {
  if (part.type === "text" || part.type === "reasoning") {
    return textStream(part.type, part.text);
  }
  if (part.type === "tool-call") {
    return [
      stream({
        input: part.input,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: "tool-call",
      }),
    ];
  }
  if (part.type === "tool-result") {
    return [
      stream({
        output: toolResultOutput(part.output),
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: "tool-result",
      }),
    ];
  }
  return [];
};

const replayUserMessage = (
  message: UserModelMessage
): SessionHistoryReplayPart => {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  return { text: text || "(attachment)", type: "user" };
};

const replayAssistantMessage = (
  message: AssistantModelMessage
): readonly SessionHistoryReplayPart[] =>
  typeof message.content === "string"
    ? textStream("text", message.content)
    : message.content.flatMap(replayContentPart);

export const sessionHistoryReplayParts = (
  history: readonly ModelMessage[]
): readonly SessionHistoryReplayPart[] => {
  const replay: SessionHistoryReplayPart[] = [{ type: "clear" }];
  for (const message of history) {
    if (message.role === "user") {
      replay.push(replayUserMessage(message));
    } else if (message.role === "assistant") {
      replay.push(...replayAssistantMessage(message));
    } else if (message.role === "tool") {
      replay.push(...message.content.flatMap(replayContentPart));
    }
  }
  return replay;
};
