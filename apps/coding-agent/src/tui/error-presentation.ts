import type {
  TurnErrorCorrelationId,
  TurnErrorMetadataV1,
} from "@minpeter/pss-runtime";
import { sanitizeTerminalText } from "./terminal-safety";

export interface TuiErrorPresentation {
  readonly correlationIds?: readonly TurnErrorCorrelationId[];
  readonly hint?: string;
  readonly message: string;
  readonly title: string;
}

const isTuiErrorPresentation = (
  value: unknown
): value is TuiErrorPresentation => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<TuiErrorPresentation>;
  return (
    typeof candidate.message === "string" && typeof candidate.title === "string"
  );
};

const categoryPresentation = (
  category: TurnErrorMetadataV1["category"] | undefined
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
  if (isTuiErrorPresentation(error)) {
    return error;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = sanitizeTerminalText(rawMessage).trim() || "Unknown error";
  const category = categoryPresentation(metadata?.category);
  const correlationIds = metadata?.correlationIds?.flatMap(
    ({ source: rawSource, value: rawValue }) => {
      const source = sanitizeTerminalText(rawSource).trim().slice(0, 128);
      const value = sanitizeTerminalText(rawValue).trim().slice(0, 256);
      return source.length === 0 ||
        value.length === 0 ||
        message.includes(value)
        ? []
        : [{ source, value }];
    }
  );

  return {
    ...category,
    ...(correlationIds === undefined || correlationIds.length === 0
      ? {}
      : { correlationIds }),
    message,
  };
};
