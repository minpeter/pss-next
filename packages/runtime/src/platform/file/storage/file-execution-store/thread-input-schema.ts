import type {
  ThreadInputKind,
  ThreadInputPlacement,
  ThreadInputRecord,
  ThreadInputStatus,
} from "../../../../execution/host/types";
import { isPlainRecord as isRecord } from "../../../../internal/guards";
import type {
  InputEventMeta,
  InputSource,
  UserInput,
  UserMessageContentPart,
  UserMessageFileData,
  UserTextContent,
} from "../../../../thread/protocol/events";

export function parseThreadInputRecords(
  value: unknown,
  file: string
): readonly ThreadInputRecord[] {
  if (!Array.isArray(value)) {
    throw invalidFile(file, "expected thread input records");
  }
  return value.map((record) => parseThreadInputRecord(record, file));
}

function parseThreadInputRecord(
  value: unknown,
  file: string
): ThreadInputRecord {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected thread input object");
  }
  if (
    typeof value.admittedAtMs !== "number" ||
    typeof value.admittedSeq !== "number" ||
    !isUserInput(value.input) ||
    !isThreadInputKind(value.kind) ||
    typeof value.messageId !== "string" ||
    !isThreadInputStatus(value.status) ||
    typeof value.threadKey !== "string"
  ) {
    throw invalidFile(file, "expected thread input fields");
  }
  if ("claimId" in value && typeof value.claimId !== "string") {
    throw invalidFile(file, "expected thread input claim id");
  }
  if ("placement" in value && !isThreadInputPlacement(value.placement)) {
    throw invalidFile(file, "expected thread input placement");
  }

  return {
    admittedAtMs: value.admittedAtMs,
    admittedSeq: value.admittedSeq,
    ...(typeof value.claimId === "string" ? { claimId: value.claimId } : {}),
    input: value.input,
    kind: value.kind,
    messageId: value.messageId,
    ...(isThreadInputPlacement(value.placement)
      ? { placement: value.placement }
      : {}),
    status: value.status,
    threadKey: value.threadKey,
  };
}

function isUserInput(value: unknown): value is UserInput {
  return (
    isRecord(value) &&
    value.type === "user-input" &&
    isOptionalInputMeta(value.meta) &&
    ("content" in value ? isUserMessageInput(value) : isUserTextInput(value))
  );
}

function isUserTextInput(
  value: Record<string, unknown>
): value is { readonly text: UserTextContent; readonly type: "user-input" } {
  return "text" in value && isUserTextContent(value.text);
}

function isUserMessageInput(value: Record<string, unknown>): value is {
  readonly content: readonly UserMessageContentPart[];
  readonly type: "user-input";
} {
  return (
    "content" in value &&
    Array.isArray(value.content) &&
    value.content.every(isUserMessageContentPart)
  );
}

function isUserTextContent(value: unknown): value is UserTextContent {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function isUserMessageContentPart(
  value: unknown
): value is UserMessageContentPart {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "text") {
    return typeof value.text === "string";
  }
  return (
    value.type === "file" &&
    isUserMessageFileData(value.data) &&
    (value.filename === undefined || typeof value.filename === "string") &&
    typeof value.mediaType === "string"
  );
}

function isUserMessageFileData(value: unknown): value is UserMessageFileData {
  if (typeof value === "string") {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "data") {
    return typeof value.data === "string";
  }
  if (value.type === "text") {
    return typeof value.text === "string";
  }
  if (value.type === "url") {
    return typeof value.url === "string";
  }
  return value.type === "reference" && isStringRecord(value.reference);
}

function isOptionalInputMeta(
  value: unknown
): value is InputEventMeta | undefined {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    isInputSource(value.source) &&
    (value.delegateToolName === undefined ||
      typeof value.delegateToolName === "string") &&
    isOptionalStreaming(value.streaming)
  );
}

function isInputSource(value: unknown): value is InputSource {
  return (
    value === "delegate" ||
    value === "follow-up" ||
    value === "notify" ||
    value === "overlay" ||
    value === "send" ||
    value === "steer"
  );
}

function isOptionalStreaming(
  value: unknown
): value is InputEventMeta["streaming"] | undefined {
  return value === undefined || value === "follow-up" || value === "steer";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isThreadInputKind(value: unknown): value is ThreadInputKind {
  return value === "follow-up" || value === "send" || value === "steer";
}

function isThreadInputPlacement(value: unknown): value is ThreadInputPlacement {
  return (
    value === "step-end" || value === "step-start" || value === "turn-start"
  );
}

function isThreadInputStatus(value: unknown): value is ThreadInputStatus {
  return (
    value === "acked" ||
    value === "claiming" ||
    value === "pending" ||
    value === "promoted"
  );
}

function invalidFile(file: string, message: string): Error {
  return new Error(
    `Invalid FileExecutionStore file ${JSON.stringify(file)}: ${message}`
  );
}
