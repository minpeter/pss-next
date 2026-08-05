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
  // An installed extension with a bundled default's id replaces the bundled
  // copy in its original slot, mirroring how CLI extensions replace
  // configured ones by id. Replacing in place keeps registration order —
  // and with it renderer priority — identical to the bundled defaults. Only
  // the first provided extension with a given id is consumed here, so a
  // second one still reaches the host's duplicate-id validation.
  const consumed = new Set<number>();
  const takeReplacement = (
    id: string
  ): CodingAgentExtensionInput | undefined => {
    const index = extensions.findIndex(
      (extension, extensionIndex) =>
        extension.id === id && !consumed.has(extensionIndex)
    );
    if (index === -1) {
      return;
    }
    consumed.add(index);
    return extensions[index];
  };
  const latexReplacement = takeReplacement(latexModule.id);
  const mermaidReplacement = takeReplacement(mermaidModule.id);
  const webReplacement =
    options.web === false
      ? undefined
      : takeReplacement("@minpeter/pss-extension-web");
  const webModule: CodingAgentExtensionInput | undefined =
    options.web === false
      ? undefined
      : (webReplacement ?? {
          default: createWebExtension(options.web),
          id: "@minpeter/pss-extension-web",
        });
  return [
    latexReplacement ?? latexModule,
    mermaidReplacement ?? mermaidModule,
    ...(webModule === undefined ? [] : [webModule]),
    ...extensions.filter((_, index) => !consumed.has(index)),
  ];
};

export const createCodingAgentExtensionHostWithDefaults = (
  extensions: readonly CodingAgentExtensionInput[],
  options: DefaultCodingAgentExtensionsOptions = {}
) =>
  createCodingAgentExtensionHost(
    withDefaultCodingAgentExtensions(extensions, options)
  );
