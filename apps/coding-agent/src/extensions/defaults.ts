import latexExtension from "@minpeter/pss-extension-latex";
import mermaidExtension from "@minpeter/pss-extension-mermaid";
import {
  type CreateCodingAgentToolsOptions,
  createWebExtension,
} from "@minpeter/pss-extension-web";
import { createCodingAgentExtensionHost } from "./host";
import type {
  CodingAgentExtensionInput,
  CodingAgentExtensionModule,
} from "./types";

const latexModule: CodingAgentExtensionModule = {
  default: latexExtension,
  id: "@minpeter/pss-extension-latex",
};

const mermaidModule: CodingAgentExtensionModule = {
  default: mermaidExtension,
  id: "@minpeter/pss-extension-mermaid",
};

export interface DefaultCodingAgentExtensionsOptions {
  readonly web?: CreateCodingAgentToolsOptions | false;
}

export const withDefaultCodingAgentExtensions = (
  extensions: readonly CodingAgentExtensionInput[],
  options: DefaultCodingAgentExtensionsOptions = {}
): readonly CodingAgentExtensionInput[] => {
  const webModule: CodingAgentExtensionModule | undefined =
    options.web === false
      ? undefined
      : {
          default: createWebExtension(options.web),
          id: "@minpeter/pss-extension-web",
        };
  // An installed extension with a bundled default's id replaces the bundled
  // copy, mirroring how CLI extensions replace configured ones by id. This
  // keeps independently updated extension packages from colliding with the
  // bundled defaults at host creation.
  const providedIds = new Set(extensions.map((extension) => extension.id));
  const bundledModules = [latexModule, mermaidModule, webModule].filter(
    (module): module is CodingAgentExtensionModule =>
      module !== undefined && !providedIds.has(module.id)
  );
  return [...bundledModules, ...extensions];
};

export const createCodingAgentExtensionHostWithDefaults = (
  extensions: readonly CodingAgentExtensionInput[],
  options: DefaultCodingAgentExtensionsOptions = {}
) =>
  createCodingAgentExtensionHost(
    withDefaultCodingAgentExtensions(extensions, options)
  );
