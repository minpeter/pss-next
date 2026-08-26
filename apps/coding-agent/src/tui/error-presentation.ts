import {
  normalizeTurnError,
  type TurnErrorCorrelationId,
  type TurnErrorMetadataV1,
} from "@minpeter/pss-runtime";
import { sanitizeTerminalText } from "./terminal-safety";

export interface TuiErrorPresentation {
  readonly correlationIds?: readonly TurnErrorCorrelationId[];
  readonly hint?: string;
  readonly message: string;
  readonly title: string;
}

const GENERIC_MESSAGE = "The request failed.";
const GENERIC_TITLE = "Request failed";
// Hostile arrays can expose billions of sparse indexes; retain only a small,
// useful diagnostic sample with fixed traversal and output budgets.
const MAX_CORRELATION_IDS_EMITTED = 32;
const MAX_CORRELATION_ITEMS_EXAMINED = 256;
const MAX_CORRELATION_SOURCE_LENGTH = 128;
const MAX_CORRELATION_VALUE_LENGTH = 256;
const MAX_HINT_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_TITLE_LENGTH = 128;

const sanitizeBounded = (text: string, maxLength: number): string => {
  const boundedInput = text.slice(0, maxLength).replace(/\r\n/g, "\n");
  let sanitized = "";
  for (const character of boundedInput) {
    const safeCharacter = sanitizeTerminalText(character, character.length);
    if (sanitized.length + safeCharacter.length > maxLength) {
      break;
    }
    sanitized += safeCharacter;
  }
  return sanitized.trim();
};

const parseCorrelationIds = (
  value: unknown,
  message: string
): readonly TurnErrorCorrelationId[] | undefined => {
  try {
    if (!Array.isArray(value)) {
      return;
    }
    const length: unknown = Reflect.get(value, "length");
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      return;
    }
    const correlationIds: TurnErrorCorrelationId[] = [];
    const seen = new Set<string>();
    const examinationLimit = Math.min(length, MAX_CORRELATION_ITEMS_EXAMINED);
    for (let index = 0; index < examinationLimit; index += 1) {
      if (correlationIds.length === MAX_CORRELATION_IDS_EMITTED) {
        break;
      }
      const item: unknown = Reflect.get(value, index);
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const rawSource: unknown = Reflect.get(item, "source");
      const rawValue: unknown = Reflect.get(item, "value");
      if (typeof rawSource !== "string" || typeof rawValue !== "string") {
        continue;
      }
      const source = sanitizeBounded(rawSource, MAX_CORRELATION_SOURCE_LENGTH);
      const correlationValue = sanitizeBounded(
        rawValue,
        MAX_CORRELATION_VALUE_LENGTH
      );
      const identity = `${source}\0${correlationValue}`;
      if (
        source.length > 0 &&
        correlationValue.length > 0 &&
        !message.includes(correlationValue) &&
        !seen.has(identity)
      ) {
        seen.add(identity);
        correlationIds.push({ source, value: correlationValue });
      }
    }
    return correlationIds.length === 0 ? undefined : correlationIds;
  } catch {
    return;
  }
};

const parseTuiErrorPresentation = (
  value: unknown
): TuiErrorPresentation | undefined => {
  try {
    if (typeof value !== "object" || value === null) {
      return;
    }
    const rawMessage: unknown = Reflect.get(value, "message");
    const rawTitle: unknown = Reflect.get(value, "title");
    const rawHint: unknown = Reflect.get(value, "hint");
    if (
      typeof rawMessage !== "string" ||
      typeof rawTitle !== "string" ||
      (rawHint !== undefined && typeof rawHint !== "string")
    ) {
      return;
    }
    const message = sanitizeBounded(rawMessage, MAX_MESSAGE_LENGTH);
    const title = sanitizeBounded(rawTitle, MAX_TITLE_LENGTH);
    if (message.length === 0 || title.length === 0) {
      return;
    }
    const hint =
      typeof rawHint === "string"
        ? sanitizeBounded(rawHint, MAX_HINT_LENGTH)
        : undefined;
    const correlationIds = parseCorrelationIds(
      Reflect.get(value, "correlationIds"),
      message
    );
    return {
      ...(correlationIds === undefined ? {} : { correlationIds }),
      ...(hint === undefined || hint.length === 0 ? {} : { hint }),
      message,
      title,
    };
  } catch {
    return;
  }
};

const categoryPresentation = (
  category: unknown
): Pick<TuiErrorPresentation, "hint" | "title"> => {
  switch (category) {
    case "authentication":
      return {
        hint: "Check your provider credentials.",
        title: "Authentication failed",
      };
    case "bad-request":
      return {
        hint: "Check the selected model and request configuration.",
        title: "Request rejected",
      };
    case "cancelled":
      return { title: "Request cancelled" };
    case "context-overflow":
      return {
        hint: "Start a new thread or reduce the conversation context.",
        title: "Context limit reached",
      };
    case "network":
      return {
        hint: "Check your network connection and provider availability.",
        title: "Connection failed",
      };
    case "permission":
      return {
        hint: "Check your provider account or model access.",
        title: "Request refused",
      };
    case "quota":
      return {
        hint: "Check your provider quota or billing status.",
        title: "Quota unavailable",
      };
    case "rate-limit":
      return {
        hint: "Wait before retrying or check your provider quota.",
        title: "Rate limit reached",
      };
    case "stream":
      return {
        hint: "Retry the request; the response stream was interrupted.",
        title: "Response interrupted",
      };
    case "timeout":
      return {
        hint: "Retry the request or check provider availability.",
        title: "Request timed out",
      };
    case "upstream":
      return {
        hint: "Retry later or check provider availability.",
        title: "Provider unavailable",
      };
    default:
      return { title: "Request failed" };
  }
};

export const createTuiErrorPresentation = (
  error: unknown,
  metadata?: TurnErrorMetadataV1
): TuiErrorPresentation => {
  const parsedPresentation = parseTuiErrorPresentation(error);
  if (parsedPresentation !== undefined) {
    return parsedPresentation;
  }

  let message = GENERIC_MESSAGE;
  try {
    const normalizedMessage =
      typeof error === "string" && metadata !== undefined
        ? error
        : normalizeTurnError(error).message;
    if (normalizedMessage !== undefined) {
      message = sanitizeBounded(normalizedMessage, MAX_MESSAGE_LENGTH);
    }
  } catch {
    message = GENERIC_MESSAGE;
  }
  if (message.length === 0) {
    message = GENERIC_MESSAGE;
  }

  let category: Pick<TuiErrorPresentation, "hint" | "title"> = {
    title: GENERIC_TITLE,
  };
  let correlationIds: readonly TurnErrorCorrelationId[] | undefined;
  try {
    if (metadata !== undefined) {
      const rawCategory: unknown = Reflect.get(metadata, "category");
      category = categoryPresentation(rawCategory);
      correlationIds = parseCorrelationIds(
        Reflect.get(metadata, "correlationIds"),
        message
      );
    }
  } catch {
    category = { title: GENERIC_TITLE };
    correlationIds = undefined;
  }

  return {
    ...category,
    ...(correlationIds === undefined ? {} : { correlationIds }),
    message,
  };
};
