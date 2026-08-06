import type {
  ThreadInputKind,
  ThreadInputPlacement,
  ThreadInputRecord,
  ThreadInputStatus,
} from "../../../../execution";
import type {
  InputEventMeta,
  InputSource,
  UserInput,
  UserMessageContentPart,
  UserMessageFileData,
  UserTextContent,
} from "../../../../thread/protocol/events";

export class StoredThreadInputRecordParseError extends Error {
  constructor() {
    super("Malformed Cloudflare thread input record.");
    this.name = "StoredThreadInputRecordParseError";
  }
}

export function parseThreadInputRecord(value: unknown): ThreadInputRecord {
  if (!isRecordObject(value)) {
    throw new StoredThreadInputRecordParseError();
  }
  const admittedAtMs = parseNumber(value.admittedAtMs);
  const admittedSeq = parseNumber(value.admittedSeq);
  const input = parseUserInput(value.input);
  const kind = parseThreadInputKind(value.kind);
  const messageId = parseString(value.messageId);
  const placement = parseOptionalThreadInputPlacement(value.placement);
  const status = parseThreadInputStatus(value.status);
  const threadKey = parseString(value.threadKey);
  const claimId = parseOptionalString(value.claimId);
  const base = {
    admittedAtMs,
    admittedSeq,
    input,
    kind,
    messageId,
    status,
    threadKey,
  };
  return {
    ...base,
    ...(claimId === undefined ? {} : { claimId }),
    ...(placement === undefined ? {} : { placement }),
  };
}

function parseUserInput(value: unknown): UserInput {
  if (isUserInput(value)) {
    return value;
  }
  throw new StoredThreadInputRecordParseError();
}

function isUserInput(value: unknown): value is UserInput {
  return (
    isRecordObject(value) &&
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
  if (!isRecordObject(value)) {
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
  if (!isRecordObject(value)) {
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
  if (!isRecordObject(value)) {
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

function parseThreadInputKind(value: unknown): ThreadInputKind {
  if (value === "follow-up" || value === "send" || value === "steer") {
    return value;
  }
  throw new StoredThreadInputRecordParseError();
}

function parseThreadInputStatus(value: unknown): ThreadInputStatus {
  if (
    value === "acked" ||
    value === "claiming" ||
    value === "pending" ||
    value === "promoted"
  ) {
    return value;
  }
  throw new StoredThreadInputRecordParseError();
}

function parseOptionalThreadInputPlacement(
  value: unknown
): ThreadInputPlacement | undefined {
  if (value === undefined) {
    return;
  }
  if (
    value === "step-end" ||
    value === "step-start" ||
    value === "turn-start"
  ) {
    return value;
  }
  throw new StoredThreadInputRecordParseError();
}

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new StoredThreadInputRecordParseError();
}

function parseString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  throw new StoredThreadInputRecordParseError();
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return;
  }
  return parseString(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecordObject(value)) {
    return false;
  }
  return Object.values(value).every(
    (entryValue) => typeof entryValue === "string"
  );
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
