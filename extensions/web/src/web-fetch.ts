import type { FetchOptions, FetchResult } from "@minpeter/opensearch/node";
import { jsonSchema, type Tool, tool } from "ai";
import { abortIfRequested } from "./errors";
import type { CodingAgentOpenSearchClient } from "./web-tools";

const MAX_FETCH_URLS = 10;

export interface WebFetchInput {
  readonly maxCharacters?: number;
  readonly urls: readonly string[];
}

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
      return await client.fetch(input.urls, getFetchOptions(input));
    },
    inputSchema: jsonSchema<WebFetchInput>({
      additionalProperties: false,
      properties: {
        maxCharacters: {
          description:
            "Optional per-page character cap. Defaults to 12000 when omitted.",
          minimum: 1,
          type: "integer",
        },
        urls: {
          description:
            "Absolute http or https URLs to fetch. Maximum 10 URLs per request.",
          items: {
            description: "Absolute http or https URL.",
            format: "uri",
            type: "string",
          },
          maxItems: MAX_FETCH_URLS,
          minItems: 1,
          type: "array",
        },
      },
      required: ["urls"],
      type: "object",
    }),
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

function getFetchOptions(input: WebFetchInput): FetchOptions | undefined {
  if (input.maxCharacters === undefined) {
    return;
  }

  return { maxCharacters: input.maxCharacters };
}
