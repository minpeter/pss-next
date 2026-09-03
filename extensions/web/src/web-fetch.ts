import type { FetchOptions, FetchResult } from "@minpeter/opensearch/node";
import { jsonSchema, type Tool, tool } from "ai";
import { z } from "zod";
import { abortIfRequested } from "./errors";
import type { CodingAgentOpenSearchClient } from "./web-tools";

const MAX_FETCH_URLS = 10;

export interface WebFetchInput {
  readonly maxCharacters?: number;
  readonly urls: readonly string[];
}

const inputSchema: z.ZodType<WebFetchInput> = z
  .object({
    maxCharacters: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Per-page character cap (default 12000)."),
    urls: z
      .array(z.url({ protocol: /^https?$/u }))
      .min(1)
      .max(MAX_FETCH_URLS)
      .describe("One to 10 absolute HTTP or HTTPS URLs to fetch."),
  })
  .strict();

export type WebFetchTool = Tool<
  WebFetchInput,
  readonly FetchResult[],
  Record<string, unknown>
>;

export function createWebFetchTool(
  client: Pick<CodingAgentOpenSearchClient, "fetch">
): WebFetchTool {
  return tool<WebFetchInput, readonly FetchResult[], Record<string, unknown>>({
    description:
      "Read one or more webpages as clean markdown with source metadata. Use after web_search when a result needs full-page content, or call directly with known URLs.",
    execute: async (input, options) => {
      abortIfRequested(options.abortSignal, "web_fetch");
      return await client.fetch(
        input.urls,
        getFetchOptions(input, options.abortSignal)
      );
    },
    inputSchema,
    outputSchema: jsonSchema<readonly FetchResult[]>({
      items: {
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          length: { type: "number" },
          title: { type: "string" },
          url: { type: "string" },
        },
        required: ["content", "length", "title", "url"],
        type: "object",
      },
      type: "array",
    }),
  });
}

function getFetchOptions(
  input: WebFetchInput,
  signal: AbortSignal | undefined
): (FetchOptions & { readonly signal?: AbortSignal }) | undefined {
  if (input.maxCharacters === undefined && signal === undefined) {
    return;
  }

  return {
    ...(input.maxCharacters === undefined
      ? {}
      : { maxCharacters: input.maxCharacters }),
    ...(signal === undefined ? {} : { signal }),
  };
}
