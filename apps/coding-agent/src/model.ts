import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/** Provider-side language model shape, derived structurally from the factory. */
type ProviderLanguageModel = ReturnType<
  ReturnType<typeof createOpenAICompatible>
>;

import { config } from "dotenv";
import {
  type CodingAgentRuntimeEnv,
  FREE_TIER_PROVIDER_LABEL,
  isFreeTierModelId,
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

/**
 * A provider-bound model session for the interactive TUI. `model` keeps a
 * stable identity for the lifetime of the session while `switchModel` swaps
 * the underlying provider model, so an already-created agent (and its
 * threads) pick up the new model on their next step.
 */
export interface CodingModelSession {
  readonly baseURL: string;
  currentModelId(): string;
  /** True when the keyless OpenCode Zen free tier is in use. */
  readonly isFreeTier: boolean;
  /** Model ids available to this session from the provider's `/models`. */
  listModelIds(): Promise<string[]>;
  /** Stable model identity; hand this to `createCodingAgent` once. */
  readonly model: LanguageModel;
  switchModel(modelId: string): void;
}

export function createOpenAICompatibleModelFromEnv({
  fetch,
  providerName,
  runtimeEnv = process.env,
}: CreateOpenAICompatibleModelFromEnvOptions = {}): LanguageModel {
  return createCodingModelSessionFromEnv({
    ...(fetch === undefined ? {} : { fetch }),
    ...(providerName === undefined ? {} : { providerName }),
    runtimeEnv,
  }).model;
}

export function createCodingLanguageModel({
  fetch,
  override = true,
  providerName,
  quiet = true,
}: CreateOpenAICompatibleModelFromDotenvOptions = {}): LanguageModel {
  config({ override, quiet });

  return createOpenAICompatibleModelFromEnv({
    ...(fetch === undefined ? {} : { fetch }),
    ...(providerName === undefined ? {} : { providerName }),
  });
}

/** Like {@link createCodingModelSessionFromEnv}, loading `.env` first. */
export function createCodingModelSession({
  fetch,
  override = true,
  providerName,
  quiet = true,
}: CreateOpenAICompatibleModelFromDotenvOptions = {}): CodingModelSession {
  config({ override, quiet });

  return createCodingModelSessionFromEnv({
    ...(fetch === undefined ? {} : { fetch }),
    ...(providerName === undefined ? {} : { providerName }),
  });
}

export function createCodingModelSessionFromEnv({
  fetch,
  providerName,
  runtimeEnv = process.env,
}: CreateOpenAICompatibleModelFromEnvOptions = {}): CodingModelSession {
  const env = readOpenAICompatibleModelEnv({ runtimeEnv });
  const provider = createOpenAICompatible({
    name:
      providerName ?? (env.isFreeTier ? FREE_TIER_PROVIDER_LABEL : "custom"),
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
    // Request usage chunks in streaming responses (`stream_options:
    // {"include_usage": true}`). Without this, OpenAI-compatible servers
    // omit token usage entirely and the TUI can only report 0 tokens.
    includeUsage: true,
    ...(fetch === undefined ? {} : { fetch }),
  });
  const switchable = createSwitchableModel(provider(env.AI_MODEL));

  return {
    baseURL: env.AI_BASE_URL,
    isFreeTier: env.isFreeTier,
    model: switchable.model,
    currentModelId: () => switchable.current().modelId,
    listModelIds: async () => {
      const ids = await fetchProviderModelIds(
        env.AI_BASE_URL,
        env.AI_API_KEY,
        fetch ?? globalThis.fetch
      );
      // Zen's `/models` includes paid models too, but its anonymous `public`
      // credential can only use ids ending in `-free`. Keep unavailable
      // entries out of both `/model` and `/model list`.
      return env.isFreeTier ? ids.filter(isFreeTierModelId) : ids;
    },
    switchModel: (modelId: string) => {
      const trimmed = modelId.trim();
      if (trimmed.length === 0) {
        throw new Error("Model id must not be empty");
      }
      if (env.isFreeTier && !isFreeTierModelId(trimmed)) {
        throw new Error(
          "The OpenCode Zen free tier only supports model ids ending in -free"
        );
      }
      switchable.switchTo(provider(trimmed));
    },
  };
}

/**
 * Wraps a provider model behind a stable object so the model can be swapped
 * mid-session. `provider`/`modelId` are kept as plain data properties
 * because runtime telemetry reads them via property descriptors.
 */
function createSwitchableModel(initial: ProviderLanguageModel): {
  current(): ProviderLanguageModel;
  readonly model: ProviderLanguageModel;
  switchTo(next: ProviderLanguageModel): void;
} {
  let delegate = initial;
  const model: ProviderLanguageModel = {
    specificationVersion: initial.specificationVersion,
    provider: delegate.provider,
    modelId: delegate.modelId,
    supportedUrls: delegate.supportedUrls,
    doGenerate: (options) => delegate.doGenerate(options),
    doStream: (options) => delegate.doStream(options),
  };
  return {
    model,
    current: () => delegate,
    switchTo: (next) => {
      delegate = next;
      Object.assign(model, {
        modelId: next.modelId,
        provider: next.provider,
        supportedUrls: next.supportedUrls,
      });
    },
  };
}

const TRAILING_SLASHES_PATTERN = /\/+$/;
const MODEL_CATALOG_TIMEOUT_MS = 15_000;

async function fetchProviderModelIds(
  baseURL: string,
  apiKey: string,
  fetch: typeof globalThis.fetch
): Promise<string[]> {
  const endpoint = `${baseURL.replace(TRAILING_SLASHES_PATTERN, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MODEL_CATALOG_TIMEOUT_MS
  );
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Model listing failed: ${response.status} ${response.statusText}`
      );
    }
    const payload: unknown = await response.json();
    const entries =
      typeof payload === "object" && payload !== null && "data" in payload
        ? (payload as { data: unknown }).data
        : undefined;
    if (!Array.isArray(entries)) {
      throw new Error("Model listing failed: unexpected response shape");
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        typeof (entry as { id: unknown }).id === "string"
      ) {
        ids.push((entry as { id: string }).id);
      }
    }
    return ids;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Model listing timed out after ${MODEL_CATALOG_TIMEOUT_MS / 1000} seconds`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
