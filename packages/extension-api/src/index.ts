import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";

export const extensionCapabilityBrand: unique symbol = Symbol.for(
  "@minpeter/pss-extension-api/capability"
);

interface Capability<Kind extends string> {
  readonly kind: Kind;
  readonly [extensionCapabilityBrand]: true;
}

export interface AssistantTextView extends Component {
  dispose?(): void;
  setText(text: string): void;
}

export interface AssistantRendererContext {
  readonly foregroundColor?: string;
  readonly markdownTheme: MarkdownTheme;
  readonly notify: (message: string) => void;
  readonly notifyOnce: (key: string, message: string) => void;
  readonly requestRender: () => void;
  readonly signal: AbortSignal;
}

export type AssistantRenderer = (
  context: AssistantRendererContext
) => AssistantTextView;

export type AssistantRendererRegistrationOptions =
  | { readonly fallback?: never; readonly override?: never }
  | { readonly fallback: true; readonly override?: never }
  | { readonly fallback?: never; readonly override: true };

export interface AssistantRendererCapability
  extends Capability<"assistant-renderer"> {
  readonly fallback: boolean;
  readonly override: boolean;
  readonly renderer: AssistantRenderer;
}

export interface InstructionsCapability extends Capability<"instructions"> {
  readonly fragments: readonly string[];
}

export type ExtensionCapability =
  | AssistantRendererCapability
  | InstructionsCapability;

export interface ExtensionAPI<CapabilityType = ExtensionCapability> {
  provide(capability: CapabilityType): void;
}

export type ExtensionFactory<CapabilityType = ExtensionCapability> = (
  pss: ExtensionAPI<CapabilityType>
) => Promise<void> | void;

export function assistantRenderer(
  renderer: AssistantRenderer,
  options: AssistantRendererRegistrationOptions = {}
): AssistantRendererCapability {
  return Object.freeze({
    [extensionCapabilityBrand]: true as const,
    fallback: options.fallback === true,
    kind: "assistant-renderer",
    override: options.override === true,
    renderer,
  });
}

export function instructions(...fragments: string[]): InstructionsCapability {
  return Object.freeze({
    [extensionCapabilityBrand]: true as const,
    fragments: Object.freeze([...fragments]),
    kind: "instructions",
  });
}
