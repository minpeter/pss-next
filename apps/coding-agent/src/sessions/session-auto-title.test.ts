import type { LanguageModel, ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  generateSessionTitle,
  sanitizeGeneratedTitle,
} from "./session-auto-title";

const history: readonly ModelMessage[] = [
  { content: "세션 이름을 자동으로 만들자", role: "user" },
  { content: "첫 응답 후 제목을 생성하겠습니다.", role: "assistant" },
];

const modelWithText = (text: string, inspect?: (options: unknown) => void) =>
  ({
    doGenerate: (options: unknown) => {
      inspect?.(options);
      return Promise.resolve({
        content: [{ text, type: "text" }],
        finishReason: { raw: undefined, unified: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      });
    },
    doStream: () => Promise.reject(new Error("Unexpected stream")),
    modelId: "title-test",
    provider: "test",
    specificationVersion: "v4",
    supportedUrls: {},
  }) as unknown as LanguageModel;

const failingModel = {
  doGenerate: () => Promise.reject(new Error("offline")),
  doStream: () => Promise.reject(new Error("Unexpected stream")),
  modelId: "title-test",
  provider: "test",
  specificationVersion: "v4",
  supportedUrls: {},
} as unknown as LanguageModel;

describe("generateSessionTitle", () => {
  it("keeps the conversation as the prompt prefix", async () => {
    const inspect = vi.fn();
    const title = await generateSessionTitle({
      history,
      instructions: "coding instructions",
      model: modelWithText("세션 자동 제목", inspect),
    });

    expect(title).toBe("세션 자동 제목");
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 24,
      temperature: 0,
    });
    const prompt = (
      inspect.mock.calls[0]?.[0] as { prompt: ModelMessage[] } | undefined
    )?.prompt;
    expect(prompt).toBeDefined();
    if (prompt === undefined) {
      throw new Error("Expected a generated model prompt");
    }
    expect(prompt[0]).toEqual({
      content: "coding instructions",
      role: "system",
    });
    expect(prompt.slice(1, history.length + 1)).toMatchObject([
      { content: [{ text: history[0]?.content }], role: "user" },
      { content: [{ text: history[1]?.content }], role: "assistant" },
    ]);
  });

  it("falls back to a truncated first user message when generation fails", async () => {
    const title = await generateSessionTitle({
      history: [
        {
          content:
            "아주 긴 사용자 요청을 바탕으로 자동 제목을 생성하지만 모델 호출에 실패한 경우에도 읽을 수 있어야 합니다",
          role: "user",
        },
        { content: "응답", role: "assistant" },
      ],
      instructions: "coding instructions",
      model: failingModel,
    });

    expect(title).toBe(
      "아주 긴 사용자 요청을 바탕으로 자동 제목을 생성하지만 모델 호출에 실패한 경우에도 읽을…"
    );
  });

  it("does not title sessions that already contain multiple user turns", async () => {
    const inspect = vi.fn();
    const title = await generateSessionTitle({
      history: [
        ...history,
        { content: "두 번째 요청", role: "user" },
        { content: "두 번째 응답", role: "assistant" },
      ],
      instructions: "coding instructions",
      model: modelWithText("제목", inspect),
    });

    expect(title).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("uses the first message fallback when a turn has no assistant text", async () => {
    const inspect = vi.fn();
    const title = await generateSessionTitle({
      history: [{ content: "도구 호출 세션", role: "user" }],
      instructions: "coding instructions",
      model: modelWithText("unused", inspect),
    });

    expect(title).toBe("도구 호출 세션");
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe("sanitizeGeneratedTitle", () => {
  it("removes common wrappers and bounds generated titles", () => {
    expect(sanitizeGeneratedTitle('제목: **"세션 자동 제목"**\n설명')).toBe(
      "세션 자동 제목"
    );
    expect(sanitizeGeneratedTitle("x".repeat(50))).toBe(`${"x".repeat(39)}…`);
    expect(sanitizeGeneratedTitle(" \n ")).toBeUndefined();
  });
});
