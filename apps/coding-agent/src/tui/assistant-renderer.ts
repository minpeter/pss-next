import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";

export interface AssistantTextView extends Component {
  dispose?(): void;
  setText(text: string): void;
}

export interface AssistantRendererContext {
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

export interface AssistantRendererNotifications {
  readonly notify: (message: string) => void;
  readonly notifyOnce: (key: string, message: string) => void;
}

export const createAssistantRendererNotifications = (
  notify: (message: string) => void
): AssistantRendererNotifications => {
  const displayedKeys = new Set<string>();
  return {
    notify,
    notifyOnce(key, message) {
      if (displayedKeys.has(key)) {
        return;
      }
      displayedKeys.add(key);
      notify(message);
    },
  };
};
