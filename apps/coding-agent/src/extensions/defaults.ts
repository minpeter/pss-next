import latexExtension from "@minpeter/pss-extension-latex";
import { createCodingAgentExtensionHost } from "./host";
import type {
  CodingAgentExtensionInput,
  CodingAgentExtensionModule,
} from "./types";

const latexModule: CodingAgentExtensionModule = {
  default: latexExtension,
  id: "@minpeter/pss-extension-latex",
};

export const withDefaultCodingAgentExtensions = (
  extensions: readonly CodingAgentExtensionInput[]
): readonly CodingAgentExtensionInput[] => [latexModule, ...extensions];

export const createCodingAgentExtensionHostWithDefaults = (
  extensions: readonly CodingAgentExtensionInput[]
) =>
  createCodingAgentExtensionHost(withDefaultCodingAgentExtensions(extensions));
