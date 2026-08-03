import { generateText, type LanguageModel, type ModelMessage } from "ai";

const GENERATED_TITLE_MAX_LENGTH = 40;
const FALLBACK_TITLE_MAX_LENGTH = 50;
const FIRST_LINE_BREAK = /\r?\n/;
const TITLE_PREFIX = /^\s*(?:title|제목)\s*:\s*/i;
const TITLE_WRAPPER = /^(?:["'`]|\*\*)+|(?:["'`]|\*\*)+$/g;
const WHITESPACE_RUN = /\s+/g;

const TITLE_REQUEST: ModelMessage = {
  content: [
    "Create a concise title for the coding session above.",
    "Use the user's language and preserve important technical names.",
    "Use 3-7 words and at most 40 characters.",
    "Return only the title, without quotes, markdown, or explanation.",
  ].join("\n"),
  role: "user",
};

export interface GenerateSessionTitleOptions {
  readonly history: readonly ModelMessage[];
  readonly instructions: string;
  readonly model: LanguageModel;
}

/**
 * Generate a title only for an initial completed turn. Keeping the original
 * instructions and history as the request prefix lets providers reuse prompt
 * caches when they support prefix caching.
 */
export async function generateSessionTitle({
  history,
  instructions,
  model,
}: GenerateSessionTitleOptions): Promise<string | undefined> {
  const userMessages = history.filter((message) => message.role === "user");
  if (userMessages.length !== 1) {
    return;
  }

  const fallback = titleFromUserMessage(userMessages[0]);
  if (!hasAssistantText(history)) {
    return fallback;
  }
  try {
    const result = await generateText({
      instructions,
      maxOutputTokens: 24,
      messages: [...history, TITLE_REQUEST],
      model,
      temperature: 0,
    });
    return sanitizeGeneratedTitle(result.text) ?? fallback;
  } catch {
    return fallback;
  }
}

export function sanitizeGeneratedTitle(value: string): string | undefined {
  const firstLine = value
    .trim()
    .split(FIRST_LINE_BREAK, 1)[0]
    ?.replace(TITLE_PREFIX, "")
    .replace(TITLE_WRAPPER, "")
    .replace(WHITESPACE_RUN, " ")
    .trim();
  if (!firstLine) {
    return;
  }
  return truncateTitle(firstLine, GENERATED_TITLE_MAX_LENGTH);
}

function hasAssistantText(history: readonly ModelMessage[]): boolean {
  return history.some(
    (message) =>
      message.role === "assistant" && messageText(message).trim().length > 0
  );
}

function titleFromUserMessage(message: ModelMessage): string | undefined {
  const text = messageText(message).replace(WHITESPACE_RUN, " ").trim();
  return text.length === 0
    ? undefined
    : truncateTitle(text, FALLBACK_TITLE_MAX_LENGTH);
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String(part.text)
        : ""
    )
    .join(" ");
}

function truncateTitle(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
