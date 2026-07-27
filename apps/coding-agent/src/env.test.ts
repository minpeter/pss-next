import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
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
    });
  });

  it("fails model env validation when the API key is missing", () => {
    expect(() =>
      readOpenAICompatibleModelEnv({
        runtimeEnv: {},
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
      readOpenAICompatibleModelEnv({ runtimeEnv: {} });
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
      readOpenAICompatibleModelEnv({ runtimeEnv: {} });
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
    expect(help).toContain("Details: OpenAI-compatible model environment");
    expect(help).toContain("\x1b[1m\x1b[31m");
    expect(help).toContain("\x1b[36m");
    expect(help).toContain("\x1b[2m");
  });
});
