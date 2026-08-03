import latexExtension from "@minpeter/pss-extension-latex";
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
  return [
    latexModule,
    ...(webModule === undefined ? [] : [webModule]),
    ...extensions,
  ];
};

export const createCodingAgentExtensionHostWithDefaults = (
  extensions: readonly CodingAgentExtensionInput[],
  options: DefaultCodingAgentExtensionsOptions = {}
) =>
  createCodingAgentExtensionHost(
    withDefaultCodingAgentExtensions(extensions, options)
  );
