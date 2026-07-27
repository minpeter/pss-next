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
    expect(model).toMatchObject({ provider: "test" });
  });

  it("falls back to the keyless free tier when env is empty", async () => {
    const { createOpenAICompatibleModelFromEnv } = await import("./model");

    createOpenAICompatibleModelFromEnv({ runtimeEnv: {} });

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "opencode-zen",
      apiKey: "public",
      baseURL: "https://opencode.ai/zen/v1",
      includeUsage: true,
    });
    expect(providerMock).toHaveBeenCalledWith("mimo-v2.5-free");
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
    expect(model).toMatchObject({ provider: "test" });
  });
});

describe("createCodingModelSessionFromEnv", () => {
  beforeEach(() => {
    dotenvConfigMock.mockReset();
    providerMock.mockReset();
    createOpenAICompatibleMock.mockReset();
    createOpenAICompatibleMock.mockReturnValue(providerMock);
  });

  const runtimeEnv = {
    AI_API_KEY: "ai-token",
    AI_BASE_URL: "https://llm.test/v1",
    AI_MODEL: "model-a",
  };

  it("keeps a stable model identity across switches", async () => {
    providerMock.mockImplementation((modelId: string) => ({
      modelId,
      provider: "test",
      specificationVersion: "v4",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    }));
    const { createCodingModelSessionFromEnv } = await import("./model");

    const session = createCodingModelSessionFromEnv({ runtimeEnv });
    const model = session.model;
    expect(session.currentModelId()).toBe("model-a");

    session.switchModel("model-b");

    expect(session.model).toBe(model);
    expect(session.currentModelId()).toBe("model-b");
    expect(providerMock).toHaveBeenCalledWith("model-b");
    // Telemetry reads modelId as a plain data property.
    const descriptor = Object.getOwnPropertyDescriptor(
      model as object,
      "modelId"
    );
    expect(descriptor?.value).toBe("model-b");
  });

  it("delegates streaming calls to the currently selected model", async () => {
    const streams = new Map<string, ReturnType<typeof vi.fn>>();
    providerMock.mockImplementation((modelId: string) => {
      const doStream = vi.fn();
      streams.set(modelId, doStream);
      return {
        modelId,
        provider: "test",
        specificationVersion: "v4",
        supportedUrls: {},
        doGenerate: vi.fn(),
        doStream,
      };
    });
    const { createCodingModelSessionFromEnv } = await import("./model");

    const session = createCodingModelSessionFromEnv({ runtimeEnv });
    const model = session.model as unknown as {
      doStream: (options: unknown) => unknown;
    };
    model.doStream({ step: 1 });
    session.switchModel("model-b");
    model.doStream({ step: 2 });

    expect(streams.get("model-a")).toHaveBeenCalledWith({ step: 1 });
    expect(streams.get("model-b")).toHaveBeenCalledWith({ step: 2 });
  });

  it("rejects blank model ids", async () => {
    providerMock.mockReturnValue({
      modelId: "model-a",
      provider: "test",
      specificationVersion: "v4",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    });
    const { createCodingModelSessionFromEnv } = await import("./model");

    const session = createCodingModelSessionFromEnv({ runtimeEnv });
    expect(() => session.switchModel("  ")).toThrow(
      "Model id must not be empty"
    );
  });

  it("lists model ids from the provider catalog endpoint", async () => {
    providerMock.mockReturnValue({
      modelId: "model-a",
      provider: "test",
      specificationVersion: "v4",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }),
          { status: 200 }
        )
      );
    try {
      const { createCodingModelSessionFromEnv } = await import("./model");
      const session = createCodingModelSessionFromEnv({ runtimeEnv });

      await expect(session.listModelIds()).resolves.toEqual([
        "model-a",
        "model-b",
      ]);
      expect(fetchSpy).toHaveBeenCalledWith("https://llm.test/v1/models", {
        headers: { Authorization: "Bearer ai-token" },
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses the caller-supplied fetch to list provider models", async () => {
    providerMock.mockReturnValue({
      modelId: "model-a",
      provider: "test",
      specificationVersion: "v4",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
        status: 200,
      })
    );
    const { createCodingModelSessionFromEnv } = await import("./model");
    const session = createCodingModelSessionFromEnv({ runtimeEnv, fetch });

    await expect(session.listModelIds()).resolves.toEqual(["model-a"]);
    expect(fetch).toHaveBeenCalledWith("https://llm.test/v1/models", {
      headers: { Authorization: "Bearer ai-token" },
    });
  });

  it("only exposes and switches to -free models on the keyless Zen tier", async () => {
    providerMock.mockImplementation((modelId: string) => ({
      modelId,
      provider: "test",
      specificationVersion: "v4",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "mimo-v2.5-free" },
            { id: "mimo-v2.5" },
            { id: "deepseek-v4-flash-free" },
          ],
        }),
        { status: 200 }
      )
    );
    try {
      const { createCodingModelSessionFromEnv } = await import("./model");
      const session = createCodingModelSessionFromEnv({ runtimeEnv: {} });

      await expect(session.listModelIds()).resolves.toEqual([
        "mimo-v2.5-free",
        "deepseek-v4-flash-free",
      ]);
      expect(() => session.switchModel("mimo-v2.5")).toThrow(
        "only supports model ids ending in -free"
      );
      expect(session.currentModelId()).toBe("mimo-v2.5-free");

      session.switchModel("deepseek-v4-flash-free");
      expect(session.currentModelId()).toBe("deepseek-v4-flash-free");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
