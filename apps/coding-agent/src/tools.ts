import {
  createOpenSearch,
  type FetchOptions,
  type FetchResult,
  type OpenSearchOptions,
  type SearchResult,
} from "@minpeter/opensearch/node";
import type { ToolSet } from "ai";

import { CodingAgentToolsConfigError } from "./tools-errors";
import { createWebFetchTool, type WebFetchTool } from "./tools-web-fetch";
import { createWebSearchTool, type WebSearchTool } from "./tools-web-search";

// biome-ignore lint/performance/noBarrelFile: the published './tools' subpath must keep re-exporting the error classes and input types after the module split.
export {
  CodingAgentToolAbortError,
  CodingAgentToolsConfigError,
} from "./tools-errors";
export type { WebFetchInput } from "./tools-web-fetch";
export type { WebSearchInput } from "./tools-web-search";

/**
 * Availability mode for the OpenSearch-backed web tools:
 *
 * - `optional`/`required` (default: `optional`): register the web tools.
 *   `@minpeter/opensearch` resolves its own providers from the environment
 *   (keyed engines such as TinyFish, Exa, Brave, ... plus keyless fallbacks
 *   like DuckDuckGo), so no provider API key is required up front.
 * - `disabled`: never register the web tools.
 */
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

/**
 * Create the OpenSearch-backed web tools. Provider selection is delegated to
 * `@minpeter/opensearch`, which picks search/fetch engines from the
 * environment and always has keyless fallbacks, so the tools are registered
 * whenever the availability mode is not `disabled`.
 */
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
