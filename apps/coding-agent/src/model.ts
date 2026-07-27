import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { config } from "dotenv";
import {
  type CodingAgentRuntimeEnv,
  readOpenAICompatibleModelEnv,
} from "./env";

export interface CreateOpenAICompatibleModelFromEnvOptions {
  /** Custom fetch, e.g. for provider observation. */
  fetch?: typeof globalThis.fetch;
  providerName?: string;
  runtimeEnv?: CodingAgentRuntimeEnv;
}

export interface CreateOpenAICompatibleModelFromDotenvOptions {
  /** Custom fetch, e.g. for provider observation. */
  fetch?: typeof globalThis.fetch;
  override?: boolean;
  providerName?: string;
  quiet?: boolean;
}

export function createOpenAICompatibleModelFromEnv({
  fetch,
  providerName = "custom",
  runtimeEnv = process.env,
}: CreateOpenAICompatibleModelFromEnvOptions = {}): LanguageModel {
  const env = readOpenAICompatibleModelEnv({ runtimeEnv });
  const provider = createOpenAICompatible({
    name: providerName,
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
    // Request usage chunks in streaming responses (`stream_options:
    // {"include_usage": true}`). Without this, OpenAI-compatible servers
    // omit token usage entirely and the TUI can only report 0 tokens.
    includeUsage: true,
    ...(fetch === undefined ? {} : { fetch }),
  });

  return provider(env.AI_MODEL);
}

export function createCodingLanguageModel({
  fetch,
  override = true,
  providerName = "custom",
  quiet = true,
}: CreateOpenAICompatibleModelFromDotenvOptions = {}): LanguageModel {
  config({ override, quiet });

  return createOpenAICompatibleModelFromEnv({
    ...(fetch === undefined ? {} : { fetch }),
    providerName,
  });
}
