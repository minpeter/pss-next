import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
  FREE_TIER_API_KEY,
  FREE_TIER_BASE_URL,
  FREE_TIER_DEFAULT_MODEL_ID,
  FREE_TIER_MODEL_ID_SUFFIX,
  formatModelEnvSetupHelp,
  isModelEnvValidationError,
  readOpenAICompatibleModelEnv,
} from "./env";

const aiApiKeyPattern = /AI_API_KEY/;
const aiBaseUrlPattern = /AI_BASE_URL/;

describe("coding-agent env validation", () => {
  it("validates and normalizes OpenAI-compatible model env", () => {
    expect(
      readOpenAICompatibleModelEnv({
        runtimeEnv: {
          AI_API_KEY: " ai-token ",
          AI_BASE_URL: "",
          AI_MODEL: "",
        },
      })
    ).toMatchObject({
      AI_API_KEY: "ai-token",
      AI_BASE_URL: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
      AI_MODEL: DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
      isFreeTier: false,
    });
  });

  it("falls back to the keyless free tier when nothing is configured", () => {
    expect(readOpenAICompatibleModelEnv({ runtimeEnv: {} })).toEqual({
      AI_API_KEY: FREE_TIER_API_KEY,
      AI_BASE_URL: FREE_TIER_BASE_URL,
      AI_MODEL: FREE_TIER_DEFAULT_MODEL_ID,
      isFreeTier: true,
    });
  });

  it("keeps an explicit AI_MODEL on the free tier", () => {
    expect(
      readOpenAICompatibleModelEnv({
        runtimeEnv: { AI_MODEL: " deepseek-v4-flash-free " },
      })
    ).toMatchObject({
      AI_MODEL: "deepseek-v4-flash-free",
      isFreeTier: true,
    });
  });

  it("rejects non-free AI_MODEL overrides on the keyless Zen tier", () => {
    expect(() =>
      readOpenAICompatibleModelEnv({
        runtimeEnv: { AI_MODEL: "mimo-v2.5" },
      })
    ).toThrow(`only supports model ids ending in ${FREE_TIER_MODEL_ID_SUFFIX}`);
  });

  it("treats blank credentials as unset for the free-tier fallback", () => {
    expect(
      readOpenAICompatibleModelEnv({
        runtimeEnv: { AI_API_KEY: "  ", AI_BASE_URL: "" },
      })
    ).toMatchObject({ isFreeTier: true });
  });

  it("fails model env validation when a base URL is set without an API key", () => {
    expect(() =>
      readOpenAICompatibleModelEnv({
        runtimeEnv: { AI_BASE_URL: "https://llm.test/v1" },
      })
    ).toThrow(aiApiKeyPattern);
  });

  it("fails model env validation when the base URL is invalid", () => {
    expect(() =>
      readOpenAICompatibleModelEnv({
        runtimeEnv: {
          AI_API_KEY: "ai-token",
          AI_BASE_URL: "not-a-url",
        },
      })
    ).toThrow(aiBaseUrlPattern);
  });

  it("does not mutate the caller-provided runtime env object", () => {
    const runtimeEnv = {
      AI_API_KEY: " ai-token ",
      AI_BASE_URL: "",
      AI_MODEL: "",
    };

    readOpenAICompatibleModelEnv({ runtimeEnv });

    expect(runtimeEnv).toEqual({
      AI_API_KEY: " ai-token ",
      AI_BASE_URL: "",
      AI_MODEL: "",
    });
  });

  it("flags model env validation errors for friendly reporting", () => {
    let thrown: unknown;
    try {
      readOpenAICompatibleModelEnv({
        runtimeEnv: { AI_BASE_URL: "https://llm.test/v1" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(isModelEnvValidationError(thrown)).toBe(true);
    expect(isModelEnvValidationError(new Error("other"))).toBe(false);
    expect(isModelEnvValidationError("nope")).toBe(false);
  });

  it("formats actionable setup help for missing credentials", () => {
    let thrown: unknown;
    try {
      readOpenAICompatibleModelEnv({
        runtimeEnv: { AI_BASE_URL: "https://llm.test/v1" },
      });
    } catch (error) {
      thrown = error;
    }

    if (!isModelEnvValidationError(thrown)) {
      throw new Error("expected a model env validation error");
    }

    const help = formatModelEnvSetupHelp(thrown);
    expect(help).toContain("export AI_API_KEY=<your-api-key>");
    expect(help).toContain(
      `AI_BASE_URL (default: ${DEFAULT_OPENAI_COMPATIBLE_BASE_URL})`
    );
    expect(help).toContain(
      `AI_MODEL    (default: ${DEFAULT_OPENAI_COMPATIBLE_MODEL_ID})`
    );
    expect(help).toContain(FREE_TIER_BASE_URL);
    expect(help).toContain("Details: OpenAI-compatible model environment");
    expect(help).toContain("\x1b[1m\x1b[31m");
    expect(help).toContain("\x1b[36m");
    expect(help).toContain("\x1b[2m");
  });
});
