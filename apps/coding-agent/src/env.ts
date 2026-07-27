import { createEnv, type StandardSchemaV1 } from "@t3-oss/env-core";
import { z } from "zod";

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL =
  "https://apis.opengateway.ai/v1";
export const DEFAULT_OPENAI_COMPATIBLE_MODEL_ID = "minimax/MiniMax-M2.7";

/**
 * Keyless fallback provider: OpenCode Zen's free tier. `public` is Zen's
 * reserved marker for anonymous requests, not a secret. Free models are
 * rate-limited per IP and the catalog can change at any time, so this is a
 * zero-setup on-ramp, not a production default.
 */
export const FREE_TIER_BASE_URL = "https://opencode.ai/zen/v1";
export const FREE_TIER_API_KEY = "public";
export const FREE_TIER_DEFAULT_MODEL_ID = "mimo-v2.5-free";
export const FREE_TIER_PROVIDER_LABEL = "opencode-zen";

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
    paint(ANSI_DIM, "Or unset AI_BASE_URL as well to fall back to the keyless"),
    paint(
      ANSI_DIM,
      `free tier (${FREE_TIER_BASE_URL}, model ${FREE_TIER_DEFAULT_MODEL_ID}).`
    ),
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

export interface ResolvedOpenAICompatibleModelEnv {
  readonly AI_API_KEY: string;
  readonly AI_BASE_URL: string;
  readonly AI_MODEL: string;
  /** True when the keyless OpenCode Zen free tier is in use. */
  readonly isFreeTier: boolean;
}

export function readOpenAICompatibleModelEnv({
  runtimeEnv = process.env,
}: ReadCodingAgentEnvOptions = {}): ResolvedOpenAICompatibleModelEnv {
  // No key and no endpoint configured: fall back to the keyless free tier
  // instead of refusing to start. An explicit AI_BASE_URL without a key
  // still fails validation so a custom endpoint is never silently ignored.
  if (isBlank(runtimeEnv.AI_API_KEY) && isBlank(runtimeEnv.AI_BASE_URL)) {
    const model = runtimeEnv.AI_MODEL?.trim();
    return {
      AI_API_KEY: FREE_TIER_API_KEY,
      AI_BASE_URL: FREE_TIER_BASE_URL,
      AI_MODEL: model ? model : FREE_TIER_DEFAULT_MODEL_ID,
      isFreeTier: true,
    };
  }

  const env = createEnv({
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
  return {
    AI_API_KEY: env.AI_API_KEY,
    AI_BASE_URL: env.AI_BASE_URL,
    AI_MODEL: env.AI_MODEL,
    isFreeTier: false,
  };
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
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
