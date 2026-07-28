import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { config } from "dotenv";
import {
  type CodingAgentRuntimeEnv,
  FREE_TIER_PROVIDER_LABEL,
  isFreeTierModelId,
  type ResolvedOpenAICompatibleModelEnv,
  readOpenAICompatibleModelEnv,
} from "./env";
import {
  ModelCatalogCache,
  type ModelCatalogCacheOptions,
} from "./model-catalog-cache";

/** Provider-side shapes derived structurally from the installed SDK factory. */
type OpenAICompatibleProvider = ReturnType<typeof createOpenAICompatible>;
type ProviderLanguageModel = ReturnType<OpenAICompatibleProvider>;

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

export interface CreateCodingModelSessionFromEnvOptions
  extends CreateOpenAICompatibleModelFromEnvOptions {
  /** Optional persistent catalog-cache root/clock for embedders and tests. */
  catalogCache?: ModelCatalogCacheOptions;
}

export interface CreateCodingModelSessionOptions
  extends CreateOpenAICompatibleModelFromDotenvOptions {
  /** Optional persistent catalog-cache root/clock for embedders and tests. */
  catalogCache?: ModelCatalogCacheOptions;
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

function createOpenAICompatibleProviderFromEnv({
  fetch,
  providerName,
  runtimeEnv = process.env,
}: CreateOpenAICompatibleModelFromEnvOptions): {
  readonly env: ResolvedOpenAICompatibleModelEnv;
  readonly provider: OpenAICompatibleProvider;
} {
  const env = readOpenAICompatibleModelEnv({ runtimeEnv });
  const provider = createOpenAICompatible({
    name:
      providerName ?? (env.isFreeTier ? FREE_TIER_PROVIDER_LABEL : "custom"),
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
    // Request usage chunks in streaming responses (`stream_options:
    // {"include_usage": true}`). Without this, compatible servers may omit
    // token usage entirely.
    includeUsage: true,
    ...(fetch === undefined ? {} : { fetch }),
  });
  return { env, provider };
}

export function createOpenAICompatibleModelFromEnv(
  options: CreateOpenAICompatibleModelFromEnvOptions = {}
): LanguageModel {
  // Return the provider's native model instance: workflows discover provider
  // serialization hooks from its constructor, while only interactive sessions
  // need the switchable wrapper.
  const { env, provider } = createOpenAICompatibleProviderFromEnv(options);
  return provider(env.AI_MODEL);
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
  catalogCache,
  fetch,
  override = true,
  providerName,
  quiet = true,
}: CreateCodingModelSessionOptions = {}): CodingModelSession {
  config({ override, quiet });

  return createCodingModelSessionFromEnv({
    ...(catalogCache === undefined ? {} : { catalogCache }),
    ...(fetch === undefined ? {} : { fetch }),
    ...(providerName === undefined ? {} : { providerName }),
  });
}

export function createCodingModelSessionFromEnv({
  catalogCache,
  fetch,
  providerName,
  runtimeEnv,
}: CreateCodingModelSessionFromEnvOptions = {}): CodingModelSession {
  const { env, provider } = createOpenAICompatibleProviderFromEnv({
    fetch,
    providerName,
    runtimeEnv,
  });
  const switchable = createSwitchableModel(provider(env.AI_MODEL));
  const persistentCatalogCache = new ModelCatalogCache(catalogCache);
  const filterAvailableModelIds = (ids: readonly string[]): string[] =>
    env.isFreeTier ? ids.filter(isFreeTierModelId) : [...ids];
  let catalogRefresh: Promise<string[]> | undefined;
  const refreshCatalog = (): Promise<string[]> => {
    if (catalogRefresh !== undefined) {
      return catalogRefresh;
    }
    catalogRefresh = fetchProviderModelIds(
      env.AI_BASE_URL,
      env.AI_API_KEY,
      fetch ?? globalThis.fetch
    )
      .then(async (ids) => {
        const normalized = uniqueModelIds(ids);
        // Cache persistence is an availability optimization, never a reason
        // for an otherwise valid provider catalog request to fail. Do not
        // retain an empty response: it is often a transient provider outage.
        if (normalized.length > 0) {
          await persistentCatalogCache
            .write(env.AI_BASE_URL, env.AI_API_KEY, normalized)
            .catch(() => undefined);
        }
        return normalized;
      })
      .finally(() => {
        catalogRefresh = undefined;
      });
    return catalogRefresh;
  };

  return {
    baseURL: env.AI_BASE_URL,
    isFreeTier: env.isFreeTier,
    model: switchable.model,
    currentModelId: () => switchable.current().modelId,
    listModelIds: async () => {
      const cached = await persistentCatalogCache.read(
        env.AI_BASE_URL,
        env.AI_API_KEY
      );
      if (cached !== undefined && persistentCatalogCache.isFresh(cached)) {
        return filterAvailableModelIds(cached.modelIds);
      }
      if (
        cached !== undefined &&
        persistentCatalogCache.isUsableStale(cached)
      ) {
        // Keep `/model` responsive while revalidating. A future invocation
        // sees the refreshed data; a failed background refresh preserves the
        // last known-good catalog until it reaches its stale limit.
        refreshCatalog().catch(() => undefined);
        return filterAvailableModelIds(cached.modelIds);
      }
      return filterAvailableModelIds(await refreshCatalog());
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

const uniqueModelIds = (modelIds: readonly string[]): string[] => [
  ...new Set(modelIds),
];

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
