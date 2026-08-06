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
  assertSupportedOptionKeys(options);
  const modeValue: unknown = Reflect.get(options, "mode");
  const fallbackValue: unknown = Reflect.get(options, "fallback");
  const overrideValue: unknown = Reflect.get(options, "override");
  // Optional properties emitted as `undefined` are semantically absent.
  const hasMode = Object.hasOwn(options, "mode") && modeValue !== undefined;
  const hasFallback =
    Object.hasOwn(options, "fallback") && fallbackValue !== undefined;
  const hasOverride =
    Object.hasOwn(options, "override") && overrideValue !== undefined;
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
    if (!ASSISTANT_RENDERER_MODES.has(modeValue as AssistantRendererMode)) {
      throw new TypeError(
        `Invalid assistant renderer mode "${String(modeValue)}"`
      );
    }
    return modeValue as AssistantRendererMode;
  }
  if (hasFallback) {
    if (fallbackValue !== true) {
      throw new TypeError("Assistant renderer fallback option must be true");
    }
    return "fallback";
  }
  if (hasOverride) {
    if (overrideValue !== true) {
      throw new TypeError("Assistant renderer override option must be true");
    }
    return "override";
  }
  return "exclusive";
}

function assertSupportedOptionKeys(options: object): void {
  for (const key of Reflect.ownKeys(options)) {
    if (key !== "mode" && key !== "fallback" && key !== "override") {
      throw new TypeError(
        `Unsupported assistant renderer option "${String(key)}"`
      );
    }
  }
}
