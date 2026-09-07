import { type AgentEvent, createAgent } from "@minpeter/pss-runtime";
import { jsonSchema, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createCodingModelSessionFromEnv } from "./model";

// Captured from a live compatible-provider response: text precedes the first
// tool delta, whose index is 2 (not 0), and arguments arrive separately.
function toolStream(indices: readonly number[]): string {
  const chunks: unknown[] = [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Inspecting." },
          finish_reason: null,
        },
      ],
    },
    ...indices.map((index) => ({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: `call-${index}`,
                type: "function",
                function: { name: "read_file", arguments: "" },
              },
            ],
            content: null,
          },
          finish_reason: null,
        },
      ],
    })),
    ...indices.map((index) => ({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                function: {
                  arguments: JSON.stringify({ path: `/fixture/${index}` }),
                },
              },
            ],
            content: null,
          },
          finish_reason: null,
        },
      ],
    })),
    {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: null,
    },
    {
      choices: [],
      usage: {
        prompt_tokens: 4807,
        completion_tokens: 116,
        total_tokens: 4923,
      },
    },
  ];
  return encodeStream(chunks);
}

function encodeStream(chunks: readonly unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

const completedStream = encodeStream([
  {
    choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }],
  },
]);

describe("compatible provider streaming tool indexes", () => {
  it.each([{ indices: [0] }, { indices: [2] }, { indices: [2, 7] }])(
    "executes and commits tools with indexes $indices without retrying",
    async ({ indices }) => {
      const execute = vi.fn(({ path }: { path: string }) => path);
      const fetch = vi.fn<typeof globalThis.fetch>();
      fetch.mockResolvedValueOnce(
        new Response(toolStream(indices), {
          headers: { "content-type": "text/event-stream" },
        })
      );
      fetch.mockResolvedValueOnce(
        new Response(completedStream, {
          headers: { "content-type": "text/event-stream" },
        })
      );
      const session = createCodingModelSessionFromEnv({
        fetch,
        runtimeEnv: {
          AI_API_KEY: "fixture",
          AI_BASE_URL: "https://fixture.test/v1",
          AI_MODEL: "fixture-model",
        },
      });
      const agent = await createAgent({
        model: session.model,
        tools: {
          read_file: tool({
            inputSchema: jsonSchema<{ path: string }>({
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            }),
            execute,
          }),
        },
      });
      try {
        const turn = await agent.thread("fixture").send("Inspect the files.");
        const events: AgentEvent[] = [];
        for await (const event of turn.events()) {
          events.push(event);
        }
        expect(events.filter((event) => event.type === "turn-error")).toEqual(
          []
        );
        expect(execute.mock.calls.map(([input]) => input)).toEqual(
          indices.map((index) => ({ path: `/fixture/${index}` }))
        );
        expect(events.filter((event) => event.type === "tool-result")).toEqual(
          indices.map((index) => ({
            type: "tool-result",
            toolCallId: `call-${index}`,
            toolName: "read_file",
            output: { type: "text", value: `/fixture/${index}` },
          }))
        );
        expect(events.at(-1)?.type).toBe("turn-end");
        expect(events.filter((event) => event.type === "model-retry")).toEqual(
          []
        );
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        await agent.dispose();
      }
    }
  );
});
