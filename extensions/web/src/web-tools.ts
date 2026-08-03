import {
  createOpenSearch,
  type FetchOptions,
  type FetchResult,
  type OpenSearchOptions,
  type SearchResult,
} from "@minpeter/opensearch/node";
import type { ToolSet } from "ai";
import { CodingAgentToolsConfigError } from "./errors";
import { createWebFetchTool, type WebFetchTool } from "./web-fetch";
import { createWebSearchTool, type WebSearchTool } from "./web-search";

export type WebToolsAvailability = "disabled" | "optional" | "required";

export interface CodingAgentOpenSearchClient {
  fetch(
    urls: readonly string[],
    options?: FetchOptions
  ): Promise<readonly FetchResult[]>;
  search(query: string, maxResults?: number): Promise<readonly SearchResult[]>;
}

export interface CreateCodingAgentToolsOptions {
  readonly client?: CodingAgentOpenSearchClient;
  readonly openSearchOptions?: OpenSearchOptions;
  readonly webToolsAvailability?: WebToolsAvailability;
}

export interface CodingAgentToolSet extends ToolSet {
  readonly web_fetch: WebFetchTool;
  readonly web_search: WebSearchTool;
}

export function createCodingAgentTools(
  options: CreateCodingAgentToolsOptions & {
    readonly webToolsAvailability?: "optional" | "required";
  }
): CodingAgentToolSet;
export function createCodingAgentTools(
  options?: CreateCodingAgentToolsOptions
): ToolSet;
export function createCodingAgentTools(
  options: CreateCodingAgentToolsOptions = {}
): ToolSet {
  const availability = options.webToolsAvailability ?? "optional";
  if (availability === "disabled") {
    return {};
  }

  const client = resolveOpenSearchClient(options);
  return {
    web_search: createWebSearchTool(client),
    web_fetch: createWebFetchTool(client),
  };
}

export function resolveStartTuiTools(
  tools?: ToolSet,
  options?: CreateCodingAgentToolsOptions
): ToolSet {
  return tools ?? createCodingAgentTools(options);
}

function resolveOpenSearchClient({
  client,
  openSearchOptions,
}: CreateCodingAgentToolsOptions): CodingAgentOpenSearchClient {
  if (client !== undefined && openSearchOptions !== undefined) {
    throw new CodingAgentToolsConfigError();
  }

  return client ?? createOpenSearch(openSearchOptions);
}
