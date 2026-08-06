import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  anthropicFactory,
  anthropicProvider,
  compatibleFactory,
  compatibleProvider,
  openaiFactory,
  openaiProvider,
} = vi.hoisted(() => ({
  anthropicFactory: vi.fn(),
  anthropicProvider: vi.fn(),
  compatibleFactory: vi.fn(),
  compatibleProvider: vi.fn(),
  openaiFactory: vi.fn(),
  openaiProvider: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: anthropicFactory }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: openaiFactory }));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: compatibleFactory,
}));

describe("provider registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anthropicFactory.mockReturnValue(anthropicProvider);
    openaiFactory.mockReturnValue(openaiProvider);
    compatibleFactory.mockReturnValue(compatibleProvider);
    for (const provider of [
      anthropicProvider,
      openaiProvider,
      compatibleProvider,
    ]) {
      provider.mockReturnValue({
        provider: "test",
      } as unknown as LanguageModel);
    }
  });

  it("preserves legacy AI_* selection ahead of provider-native keys", async () => {
    const { createProviderModelFromEnv, resolveProviderSelection } =
      await import("./provider-registry");
    const runtimeEnv = {
      AI_API_KEY: "legacy-key",
      AI_BASE_URL: "https://gateway.test/v1",
      AI_MODEL: "legacy-model",
      ANTHROPIC_API_KEY: "anthropic-key",
    };

    expect(resolveProviderSelection(runtimeEnv).descriptor.id).toBe(
      "openai-compatible"
    );
    await createProviderModelFromEnv({ runtimeEnv });

    expect(compatibleFactory).toHaveBeenCalledWith({
      apiKey: "legacy-key",
      baseURL: "https://gateway.test/v1",
      includeUsage: true,
      name: "custom",
    });
    expect(compatibleProvider).toHaveBeenCalledWith("legacy-model");
    expect(anthropicFactory).not.toHaveBeenCalled();
  });

  it("detects Anthropic from its native API key and lazily creates its model", async () => {
    const { createProviderModelFromEnv, resolveProviderSelection } =
      await import("./provider-registry");
    const runtimeEnv = {
      ANTHROPIC_API_KEY: "anthropic-key",
      ANTHROPIC_MODEL: "claude-custom",
    };

    expect(resolveProviderSelection(runtimeEnv)).toMatchObject({
      descriptor: { id: "anthropic" },
      modelId: "claude-custom",
    });
    await createProviderModelFromEnv({ runtimeEnv });

    expect(anthropicFactory).toHaveBeenCalledWith({ apiKey: "anthropic-key" });
    expect(anthropicProvider).toHaveBeenCalledWith("claude-custom");
    expect(openaiFactory).not.toHaveBeenCalled();
    expect(compatibleFactory).not.toHaveBeenCalled();
  });

  it("detects OpenAI and supports an injected fetch", async () => {
    const { createProviderModelFromEnv } = await import("./provider-registry");
    const fetch = vi.fn<typeof globalThis.fetch>();
    await createProviderModelFromEnv({
      fetch,
      runtimeEnv: { OPENAI_API_KEY: "openai-key", OPENAI_MODEL: "gpt-custom" },
    });

    expect(openaiFactory).toHaveBeenCalledWith({ apiKey: "openai-key", fetch });
    expect(openaiProvider).toHaveBeenCalledWith("gpt-custom");
  });

  it("allows explicit selection with the universal AI_API_KEY", async () => {
    const { createProviderModelFromEnv } = await import("./provider-registry");
    await createProviderModelFromEnv({
      runtimeEnv: {
        AI_API_KEY: "universal-key",
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-explicit",
      },
    });

    expect(openaiFactory).toHaveBeenCalledWith({ apiKey: "universal-key" });
    expect(openaiProvider).toHaveBeenCalledWith("gpt-explicit");
  });

  it("rejects unknown explicit providers with the available ids", async () => {
    const { resolveProviderSelection } = await import("./provider-registry");
    expect(() => resolveProviderSelection({ AI_PROVIDER: "mystery" })).toThrow(
      "Expected one of: anthropic, openai, openai-compatible"
    );
  });

  it("keeps the keyless compatible free tier as the empty-env fallback", async () => {
    const { createProviderModelFromEnv } = await import("./provider-registry");
    await createProviderModelFromEnv({ runtimeEnv: {} });
    expect(compatibleFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "public",
        baseURL: "https://opencode.ai/zen/v1",
        name: "opencode-zen",
      })
    );
    expect(compatibleProvider).toHaveBeenCalledWith("mimo-v2.5-free");
  });
});
