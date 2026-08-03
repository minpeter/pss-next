import type { SearchResult } from "@minpeter/opensearch/node";
import { jsonSchema, type Tool, tool } from "ai";
import { abortIfRequested } from "./errors";
import type { CodingAgentOpenSearchClient } from "./web-tools";

const DEFAULT_SEARCH_RESULT_COUNT = 5;
const MAX_SEARCH_RESULTS = 15;

export interface WebSearchInput {
  readonly numResults?: number;
  readonly query: string;
}

export type WebSearchTool = Tool<
  WebSearchInput,
  readonly SearchResult[],
  Record<string, unknown>
>;

export function createWebSearchTool(
  client: Pick<CodingAgentOpenSearchClient, "search">
): WebSearchTool {
  return tool<WebSearchInput, readonly SearchResult[], Record<string, unknown>>(
    {
      description:
        "Search the web for current facts, documentation, news, people, companies, and other external information. Follow promising URLs with web_fetch when full page content is needed.",
      execute: async (input, options) => {
        abortIfRequested(options.abortSignal, "web_search");
        return await client.search(
          input.query,
          input.numResults ?? DEFAULT_SEARCH_RESULT_COUNT
        );
      },
      inputSchema: jsonSchema<WebSearchInput>({
        additionalProperties: false,
        properties: {
          numResults: {
            description:
              "Optional result count from 1 to 15. Defaults to 5 when omitted.",
            maximum: MAX_SEARCH_RESULTS,
            minimum: 1,
            type: "integer",
          },
          query: {
            description:
              "Non-empty natural-language search query. Search operators such as site:example.com may be included.",
            minLength: 1,
            type: "string",
          },
        },
        required: ["query"],
        type: "object",
      }),
      outputSchema: jsonSchema<readonly SearchResult[]>({
        items: {
          additionalProperties: false,
          properties: {
            engine: { type: "string" },
            snippet: { type: "string" },
            title: { type: "string" },
            url: { type: "string" },
          },
          required: ["engine", "snippet", "title", "url"],
          type: "object",
        },
        type: "array",
      }),
    }
  );
}
