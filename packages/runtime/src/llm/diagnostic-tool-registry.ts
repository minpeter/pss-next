import type { ToolSet } from "ai";
import { isRecord as isObjectRecord } from "../internal/guards";
import { isPlainRecord } from "./tool-property-descriptors";
import {
  markSemanticToolUnavailable,
  SEMANTIC_TOOL_UNAVAILABLE,
} from "./tool-semantic-metadata";

const SEMANTIC_TOOL_FIELDS = [
  "args",
  "description",
  "id",
  "inputExamples",
  "inputSchema",
  "providerOptions",
  "strict",
  "title",
  "type",
] as const;

export function diagnosticToolRegistry(tools: ToolSet): ToolSet {
  const snapshot: ToolSet = Object.create(null);
  for (const name of Object.keys(tools)) {
    try {
      const tool = tools[name];
      if (tool === undefined) {
        Object.defineProperty(snapshot, name, {
          configurable: true,
          enumerable: true,
          value: undefined,
          writable: true,
        });
        continue;
      }
      if (!isObjectRecord(tool)) {
        snapshot[name] = tool;
        continue;
      }
      const definition: Record<PropertyKey, unknown> = Object.create(null);
      if (!isPlainRecord(tool)) {
        markSemanticToolUnavailable(definition);
      }
      for (const field of SEMANTIC_TOOL_FIELDS) {
        const descriptor = Object.getOwnPropertyDescriptor(tool, field);
        if (descriptor) {
          Object.defineProperty(definition, field, descriptor);
        }
      }
      snapshot[name] = Object.freeze(definition) as ToolSet[string];
    } catch {
      const unavailable: Record<PropertyKey, unknown> = Object.create(null);
      Object.defineProperty(unavailable, SEMANTIC_TOOL_UNAVAILABLE, {
        value: true,
      });
      snapshot[name] = Object.freeze(unavailable) as ToolSet[string];
    }
  }
  return Object.freeze(snapshot);
}
