import type { LanguageModel } from "ai";
import {
  type CodingAgentRuntimeEnv,
  DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
  readOpenAICompatibleModelEnv,
} from "./env";

export type BuiltInProviderId = "anthropic" | "openai" | "openai-compatible";

export interface ProviderDescriptor {
  /** Provider-native API-key variable, in selection priority order. */
  readonly apiKeyEnv: string;
  readonly defaultModelId: string;
  /** Stable value accepted by `AI_PROVIDER`. */
  readonly id: BuiltInProviderId;
  readonly label: string;
  readonly modelEnv: string;
}

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] =
  Object.freeze([
    Object.freeze({
      apiKeyEnv: "ANTHROPIC_API_KEY",
      defaultModelId: "claude-sonnet-4-6",
      id: "anthropic",
      label: "Anthropic",
      modelEnv: "ANTHROPIC_MODEL",
    }),
    Object.freeze({
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModelId: "gpt-5.4",
      id: "openai",
      label: "OpenAI",
      modelEnv: "OPENAI_MODEL",
    }),
    Object.freeze({
      apiKeyEnv: "AI_API_KEY",
      defaultModelId: DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
      id: "openai-compatible",
      label: "OpenAI-compatible",
      modelEnv: "AI_MODEL",
    }),
  ]);

export interface ResolvedProviderSelection {
  readonly descriptor: ProviderDescriptor;
  readonly modelId: string;
}

export interface CreateProviderModelFromEnvOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly runtimeEnv?: CodingAgentRuntimeEnv;
}

const descriptorById = new Map(
  PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor])
);

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

function explicitProvider(
  runtimeEnv: CodingAgentRuntimeEnv
): ProviderDescriptor | undefined {
  const id = nonBlank(runtimeEnv.AI_PROVIDER);
  if (id === undefined) {
    return;
  }
  const descriptor = descriptorById.get(id as BuiltInProviderId);
  if (descriptor === undefined) {
    throw new Error(
      `Unknown AI_PROVIDER ${JSON.stringify(id)}. Expected one of: ${PROVIDER_DESCRIPTORS.map(({ id: providerId }) => providerId).join(", ")}.`
    );
  }
  return descriptor;
}

/**
 * Select a built-in provider without importing any adapter. Existing
 * `AI_API_KEY`/`AI_BASE_URL` setups always retain OpenAI-compatible behavior;
 * otherwise provider-native keys are detected in descriptor order.
 */
export function resolveProviderSelection(
  runtimeEnv: CodingAgentRuntimeEnv = process.env
): ResolvedProviderSelection {
  const explicit = explicitProvider(runtimeEnv);
  let descriptor = explicit;
  if (descriptor === undefined) {
    if (
      nonBlank(runtimeEnv.AI_API_KEY) !== undefined ||
      nonBlank(runtimeEnv.AI_BASE_URL) !== undefined
    ) {
      descriptor = descriptorById.get("openai-compatible");
    } else {
      descriptor = PROVIDER_DESCRIPTORS.find(
        ({ apiKeyEnv }) => nonBlank(runtimeEnv[apiKeyEnv]) !== undefined
      );
    }
  }
  descriptor ??= descriptorById.get("openai-compatible");
  if (descriptor === undefined) {
    throw new Error("The OpenAI-compatible provider descriptor is missing.");
  }
  const modelId =
    nonBlank(runtimeEnv[descriptor.modelEnv]) ??
    nonBlank(runtimeEnv.AI_MODEL) ??
    descriptor.defaultModelId;
  return { descriptor, modelId };
}

function requiredApiKey(
  descriptor: ProviderDescriptor,
  runtimeEnv: CodingAgentRuntimeEnv
): string {
  // AI_API_KEY remains a universal explicit credential when AI_PROVIDER is
  // set, while native variables enable zero-configuration provider detection.
  const key =
    nonBlank(runtimeEnv[descriptor.apiKeyEnv]) ??
    nonBlank(runtimeEnv.AI_API_KEY);
  if (key === undefined) {
    throw new Error(
      `${descriptor.label} requires ${descriptor.apiKeyEnv} (or AI_API_KEY with AI_PROVIDER=${descriptor.id}).`
    );
  }
  return key;
}

/** Create the selected model, dynamically importing only its adapter. */
export async function createProviderModelFromEnv({
  fetch,
  runtimeEnv = process.env,
}: CreateProviderModelFromEnvOptions = {}): Promise<LanguageModel> {
  const { descriptor, modelId } = resolveProviderSelection(runtimeEnv);
  if (descriptor.id === "openai-compatible") {
    const env = readOpenAICompatibleModelEnv({ runtimeEnv });
    const { createOpenAICompatible } = await import(
      "@ai-sdk/openai-compatible"
    );
    return createOpenAICompatible({
      apiKey: env.AI_API_KEY,
      baseURL: env.AI_BASE_URL,
      includeUsage: true,
      name: env.isFreeTier ? "opencode-zen" : "custom",
      ...(fetch === undefined ? {} : { fetch }),
    })(env.AI_MODEL);
  }
  const apiKey = requiredApiKey(descriptor, runtimeEnv);
  if (descriptor.id === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({
      apiKey,
      ...(fetch === undefined ? {} : { fetch }),
    })(modelId);
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  return createOpenAI({
    apiKey,
    ...(fetch === undefined ? {} : { fetch }),
  })(modelId);
}
