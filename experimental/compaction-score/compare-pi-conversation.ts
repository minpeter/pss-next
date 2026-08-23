import type { ModelMessage } from "ai";
import { COMPARISON_SUMMARY_OUTPUT_BUDGET } from "./compare-pi-config";

const PI_TOOL_RESULT_MAX_CHARS = 2000;

export interface PiFileOperations {
  readonly edited: ReadonlySet<string>;
  readonly read: ReadonlySet<string>;
}

export interface MutablePiFileOperations {
  readonly edited: Set<string>;
  readonly read: Set<string>;
}

export function serializePiConversation(
  messages: readonly ModelMessage[]
): string {
  const parts: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const content = plainText(message.content);
        if (content) {
          parts.push(`[User]: ${content}`);
        }
        break;
      }
      case "assistant":
        parts.push(...serializeAssistant(message));
        break;
      case "tool": {
        const content = toolResultText(message.content);
        if (content) {
          parts.push(
            `[Tool result]: ${truncateForSummary(content, PI_TOOL_RESULT_MAX_CHARS)}`
          );
        }
        break;
      }
      case "system":
        break;
      default:
        return message;
    }
  }
  return parts.join("\n\n");
}

function serializeAssistant(
  message: Extract<ModelMessage, { role: "assistant" }>
): string[] {
  const parts: string[] = [];
  const text = plainText(message.content);
  const toolCalls: string[] = [];
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "tool-call") {
        const args = objectEntries(part.input ?? {})
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(", ");
        toolCalls.push(`${part.toolName}(${args})`);
      }
    }
  }
  if (text) {
    parts.push(`[Assistant]: ${text}`);
  }
  if (toolCalls.length > 0) {
    parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
  }
  return parts;
}

function objectEntries(value: unknown): [string, unknown][] {
  return typeof value === "object" && value !== null
    ? Object.entries(value)
    : [];
}

function plainText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { text: string; type: "text" } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text"
    )
    .map((part) => part.text)
    .join("\n");
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const values: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "tool-result" &&
      "output" in part &&
      typeof part.output === "object" &&
      part.output !== null &&
      "value" in part.output &&
      typeof part.output.value === "string"
    ) {
      values.push(part.output.value);
    }
  }
  return values.join("\n");
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

export function collectFileOperations(
  messages: readonly ModelMessage[],
  fileOperations: MutablePiFileOperations
): void {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-call") {
        recordFileOperation(part.toolName, part.input, fileOperations);
      }
    }
  }
}

function recordFileOperation(
  toolName: string,
  rawInput: unknown,
  fileOperations: MutablePiFileOperations
): void {
  const path =
    typeof rawInput === "object" &&
    rawInput !== null &&
    "path" in rawInput &&
    typeof rawInput.path === "string"
      ? rawInput.path
      : undefined;
  if (!path) {
    return;
  }
  if (toolName === "read") {
    fileOperations.read.add(path);
  } else if (toolName === "write" || toolName === "edit") {
    fileOperations.edited.add(path);
  }
}

export function assemblePiSummary(
  providerSummary: string,
  fileOperations: PiFileOperations
): string {
  const appendix = formatFileOperations(fileOperations);
  const providerCharacters = Math.max(
    0,
    COMPARISON_SUMMARY_OUTPUT_BUDGET.maxCharacters - appendix.length
  );
  return `${providerSummary.slice(0, providerCharacters)}${appendix}`.slice(
    0,
    COMPARISON_SUMMARY_OUTPUT_BUDGET.maxCharacters
  );
}

function formatFileOperations(fileOperations: PiFileOperations): string {
  const compareFiles = (a: string, b: string) => a.localeCompare(b);
  const modified = [...fileOperations.edited].sort(compareFiles);
  const readOnly = [...fileOperations.read]
    .filter((file) => !fileOperations.edited.has(file))
    .sort(compareFiles);
  const sections: string[] = [];
  if (readOnly.length > 0) {
    sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
  }
  if (modified.length > 0) {
    sections.push(
      `<modified-files>\n${modified.join("\n")}\n</modified-files>`
    );
  }
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}
