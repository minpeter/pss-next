import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAICompatibleMock, dotenvConfigMock, providerMock } =
  vi.hoisted(() => ({
    createOpenAICompatibleMock: vi.fn(),
    dotenvConfigMock: vi.fn(),
    providerMock: vi.fn(),
  }));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

vi.mock("dotenv", () => ({
  config: dotenvConfigMock,
}));

describe("createOpenAICompatibleModelFromEnv", () => {
  const aiEnvKeys = ["AI_API_KEY", "AI_BASE_URL", "AI_MODEL"] as const;
  const originalEnv = Object.fromEntries(
    aiEnvKeys.map((key) => [key, process.env[key]])
  ) as Record<(typeof aiEnvKeys)[number], string | undefined>;

  const restoreAiEnv = () => {
    for (const key of aiEnvKeys) {
      const value = originalEnv[key];

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  beforeEach(() => {
    vi.resetModules();
    restoreAiEnv();
    dotenvConfigMock.mockReset();
    providerMock.mockReset();
    providerMock.mockReturnValue({
      provider: "test",
    } as unknown as LanguageModel);
    createOpenAICompatibleMock.mockReset();
    createOpenAICompatibleMock.mockReturnValue(providerMock);
  });

  afterEach(() => {
    restoreAiEnv();
  });

  it("builds a caller-owned LanguageModel from OpenAI-compatible env", async () => {
    const { createOpenAICompatibleModelFromEnv } = await import("./model");

    const model = createOpenAICompatibleModelFromEnv({
      runtimeEnv: {
        AI_API_KEY: " ai-token-1;ai-token-2 ",
        AI_BASE_URL: " https://llm.test/v1 ",
        AI_MODEL: " minimax/MiniMax-M2.7 ",
      },
    });

    expect(dotenvConfigMock).not.toHaveBeenCalled();
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "custom",
      apiKey: "ai-token-1;ai-token-2",
      baseURL: "https://llm.test/v1",
      includeUsage: true,
    });
    expect(providerMock).toHaveBeenCalledWith("minimax/MiniMax-M2.7");
    expect(model).toEqual({ provider: "test" });
  });

  it("loads dotenv only through the explicit dotenv helper", async () => {
    process.env.AI_API_KEY = " dotenv-token ";
    process.env.AI_BASE_URL = " https://dotenv.test/v1 ";
    process.env.AI_MODEL = " dotenv-model ";
    const { createCodingLanguageModel } = await import("./model");

    const model = createCodingLanguageModel({
      override: false,
      providerName: "dotenv-provider",
      quiet: false,
    });

    expect(dotenvConfigMock).toHaveBeenCalledWith({
      override: false,
      quiet: false,
    });
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "dotenv-provider",
      apiKey: "dotenv-token",
      baseURL: "https://dotenv.test/v1",
      includeUsage: true,
    });
    expect(providerMock).toHaveBeenCalledWith("dotenv-model");
    expect(model).toEqual({ provider: "test" });
  });
});
