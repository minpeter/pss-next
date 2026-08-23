import type { ToolSet } from "ai";

function snapshotToolDefinition(
  toolName: string,
  toolDefinition: unknown
): unknown {
  if (
    (typeof toolDefinition !== "object" &&
      typeof toolDefinition !== "function") ||
    toolDefinition === null
  ) {
    return toolDefinition;
  }

  const snapshot: Record<PropertyKey, unknown> = {};
  for (const property of Reflect.ownKeys(toolDefinition)) {
    const descriptor = Object.getOwnPropertyDescriptor(
      toolDefinition,
      property
    );
    if (descriptor === undefined) {
      continue;
    }
    if (property === "needsApproval") {
      throw new TypeError(
        `Agent tools.${toolName}.needsApproval is not supported. ` +
          "Use the pss tool.call.before checkpoint recovery hook instead of AI SDK tool approval."
      );
    }
    if (!(descriptor.enumerable && "value" in descriptor)) {
      continue;
    }
    Object.defineProperty(snapshot, property, {
      enumerable: true,
      value: descriptor.value,
    });
  }
  return snapshot;
}

export function assertNoUnsupportedToolApproval(tools: unknown): void {
  snapshotToolsWithoutUnsupportedApproval(tools);
}

export function snapshotToolsWithoutUnsupportedApproval(
  tools: unknown
): ToolSet | undefined {
  if (tools === undefined) {
    return;
  }
  if (tools === null || typeof tools !== "object") {
    throw new TypeError("Agent tools must be an object.");
  }

  const snapshot: ToolSet = {};
  for (const toolName of Reflect.ownKeys(tools)) {
    if (typeof toolName !== "string") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(tools, toolName);
    if (descriptor === undefined || !descriptor.enumerable) {
      continue;
    }
    if (!("value" in descriptor)) {
      throw new TypeError(`Agent tools.${toolName} must be a data property.`);
    }
    const toolDefinition: unknown = descriptor.value;
    Object.defineProperty(snapshot, toolName, {
      enumerable: true,
      value: snapshotToolDefinition(toolName, toolDefinition),
    });
  }
  return snapshot;
}
