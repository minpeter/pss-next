import type { ToolSet } from "ai";

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
    const toolDefinition = descriptor.value;
    if (
      (typeof toolDefinition === "object" ||
        typeof toolDefinition === "function") &&
      toolDefinition !== null &&
      "needsApproval" in toolDefinition
    ) {
      throw new TypeError(
        `Agent tools.${toolName}.needsApproval is not supported. ` +
          "Use the pss tool.call.before checkpoint recovery hook instead of AI SDK tool approval."
      );
    }
    Object.defineProperty(snapshot, toolName, {
      enumerable: true,
      value: toolDefinition,
    });
  }
  return snapshot;
}
