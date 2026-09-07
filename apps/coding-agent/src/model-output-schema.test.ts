import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output } from "ai";
import { expect, it } from "vitest";
import { z } from "zod";
import { createEditFileTool } from "./workspace-tools/edit-file";

it("preserves structured output schema alongside non-strict tool generation", async () => {
  const requests: unknown[] = [];
  const provider = createOpenAICompatible({
    name: "fixture",
    apiKey: "fixture-key",
    baseURL: "https://fixture.invalid/v1",
    supportsStructuredOutputs: true,
    fetch: (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        Response.json({
          id: "fixture-response",
          object: "chat.completion",
          created: 0,
          model: "fixture-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"ok":true}' },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    },
  });
  const result = await generateText({
    model: provider("fixture-model"),
    prompt: "Return the fixture output without calling a tool.",
    output: Output.object({ schema: z.object({ ok: z.boolean() }) }),
    tools: { edit_file: createEditFileTool("/unused-fixture-workspace") },
  });
  expect(result.output).toEqual({ ok: true });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    response_format: {
      type: "json_schema",
      json_schema: {
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    },
    tools: [{ function: { name: "edit_file", strict: false } }],
  });
});
