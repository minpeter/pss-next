import type {
  AssistantRendererMode,
  AssistantRendererRegistrationOptions,
} from "../tui/assistant-renderer";

const ASSISTANT_RENDERER_MODES = new Set<AssistantRendererMode>([
  "exclusive",
  "fallback",
  "override",
]);

/** Parse both canonical renderer modes and deprecated boolean options. */
export function parseAssistantRendererMode(
  options: AssistantRendererRegistrationOptions
): AssistantRendererMode {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("Assistant renderer options must be an object");
  }
  const hasMode = Object.hasOwn(options, "mode");
  const hasFallback = Object.hasOwn(options, "fallback");
  const hasOverride = Object.hasOwn(options, "override");
  if (hasMode && (hasFallback || hasOverride)) {
    throw new TypeError(
      "Assistant renderer mode cannot be combined with legacy fallback or override options"
    );
  }
  if (hasFallback && hasOverride) {
    throw new TypeError(
      "Assistant renderer fallback and override options cannot be combined"
    );
  }
  if (hasMode) {
    const mode: unknown = Reflect.get(options, "mode");
    if (!ASSISTANT_RENDERER_MODES.has(mode as AssistantRendererMode)) {
      throw new TypeError(`Invalid assistant renderer mode "${String(mode)}"`);
    }
    return mode as AssistantRendererMode;
  }
  if (hasFallback) {
    if (Reflect.get(options, "fallback") !== true) {
      throw new TypeError("Assistant renderer fallback option must be true");
    }
    return "fallback";
  }
  if (hasOverride) {
    if (Reflect.get(options, "override") !== true) {
      throw new TypeError("Assistant renderer override option must be true");
    }
    return "override";
  }
  return "exclusive";
}
