import { createEnv, type StandardSchemaV1 } from "@t3-oss/env-core";
import { z } from "zod";

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL =
  "https://apis.opengateway.ai/v1";
export const DEFAULT_OPENAI_COMPATIBLE_MODEL_ID = "minimax/MiniMax-M2.7";

export type CodingAgentRuntimeEnv = Record<string, string | undefined>;

interface ReadCodingAgentEnvOptions {
  runtimeEnv?: CodingAgentRuntimeEnv;
}

export const MODEL_ENV_VALIDATION_ERROR_PREFIX =
  "OpenAI-compatible model environment validation failed.";

export const isModelEnvValidationError = (error: unknown): error is Error =>
  error instanceof Error &&
  error.message.startsWith(MODEL_ENV_VALIDATION_ERROR_PREFIX);

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RED = "\x1b[31m";
const ANSI_CYAN = "\x1b[36m";

const paint = (prefix: string, text: string): string =>
  `${prefix}${text}${ANSI_RESET}`;

export const formatModelEnvSetupHelp = (error: Error): string =>
  [
    paint(
      `${ANSI_BOLD}${ANSI_RED}`,
      "✗ pss could not start: the model environment is not configured."
    ),
    "",
    "Set an API key before launching, either via the environment:",
    paint(ANSI_CYAN, "  export AI_API_KEY=<your-api-key>"),
    "or via a .env file in the current directory:",
    paint(ANSI_CYAN, "  AI_API_KEY=<your-api-key>"),
    "",
    paint(ANSI_DIM, "Optional overrides:"),
    paint(
      ANSI_DIM,
      `  AI_BASE_URL (default: ${DEFAULT_OPENAI_COMPATIBLE_BASE_URL})`
    ),
    paint(
      ANSI_DIM,
      `  AI_MODEL    (default: ${DEFAULT_OPENAI_COMPATIBLE_MODEL_ID})`
    ),
    "",
    paint(ANSI_DIM, `Details: ${error.message}`),
    "",
  ].join("\n");

export function readOpenAICompatibleModelEnv({
  runtimeEnv = process.env,
}: ReadCodingAgentEnvOptions = {}) {
  return createEnv({
    emptyStringAsUndefined: true,
    onValidationError: failEnvValidation(MODEL_ENV_VALIDATION_ERROR_PREFIX),
    runtimeEnv: { ...runtimeEnv },
    server: {
      AI_API_KEY: z.string().trim().min(1),
      AI_BASE_URL: z.url().trim().default(DEFAULT_OPENAI_COMPATIBLE_BASE_URL),
      AI_MODEL: z
        .string()
        .trim()
        .min(1)
        .default(DEFAULT_OPENAI_COMPATIBLE_MODEL_ID),
    },
  });
}

function failEnvValidation(prefix: string) {
  return (issues: readonly StandardSchemaV1.Issue[]): never => {
    const summary = issues
      .map(({ message, path }) => {
        const segment = path?.[0];
        const key =
          typeof segment === "object" && segment !== null
            ? segment.key
            : segment;

        return key === undefined ? message : `${String(key)}: ${message}`;
      })
      .join("; ");

    throw new Error(`${prefix} ${summary}`.trim());
  };
}
