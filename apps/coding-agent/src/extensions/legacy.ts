/**
 * Compatibility API for registry-based extensions.
 *
 * New extensions should default-export a factory using `ExtensionAPI` from
 * `@minpeter/pss-coding-agent/extension`.
 */
export type {
  CodingAgentExtension,
  CodingAgentExtensionRegistry,
  CodingAgentExtensionSetupContext,
} from "./types";

import type { CodingAgentExtension } from "./types";

/** @deprecated Default-export a factory function instead. */
export function defineLegacyCodingAgentExtension(
  extension: CodingAgentExtension
): CodingAgentExtension {
  return extension;
}
