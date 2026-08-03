// biome-ignore-all lint/performance/noBarrelFile: public extension package entrypoint
import {
  type CodingAgentExtensionFactory,
  toolRenderer,
  tools,
} from "@minpeter/pss-coding-agent/extension";
import { renderWebFetch, renderWebSearch } from "./renderers";
import {
  type CreateCodingAgentToolsOptions,
  createCodingAgentTools,
} from "./web-tools";

export {
  CodingAgentToolAbortError,
  CodingAgentToolsConfigError,
} from "./errors";
export type { WebFetchInput } from "./web-fetch";
export type { WebSearchInput } from "./web-search";
export {
  type CodingAgentOpenSearchClient,
  type CodingAgentToolSet,
  type CreateCodingAgentToolsOptions,
  createCodingAgentTools,
  resolveStartTuiTools,
  type WebToolsAvailability,
} from "./web-tools";

export const createWebExtension = (
  options: CreateCodingAgentToolsOptions = {}
): CodingAgentExtensionFactory => {
  const definitions = createCodingAgentTools(options);
  return (pss) => {
    if (Object.keys(definitions).length === 0) {
      return;
    }
    pss.provide(tools(definitions));
    pss.provide(toolRenderer("web_search", renderWebSearch));
    pss.provide(toolRenderer("web_fetch", renderWebFetch));
  };
};

const createDefaultWebExtension: CodingAgentExtensionFactory = (pss) =>
  createWebExtension()(pss);

export default createDefaultWebExtension;
