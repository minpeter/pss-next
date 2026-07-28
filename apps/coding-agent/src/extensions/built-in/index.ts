import { createCodingAgentExtensionHost } from "../host";
import type { CodingAgentExtensionInput } from "../types";
import { createLatexExtension } from "./latex";

export const withBuiltInCodingAgentExtensions = (
  extensions: readonly CodingAgentExtensionInput[]
): readonly CodingAgentExtensionInput[] => [
  createLatexExtension(),
  ...extensions,
];

export const createCodingAgentExtensionHostWithBuiltIns = (
  extensions: readonly CodingAgentExtensionInput[]
) =>
  createCodingAgentExtensionHost(withBuiltInCodingAgentExtensions(extensions));
