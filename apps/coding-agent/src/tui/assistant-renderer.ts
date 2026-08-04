import {
  type Component,
  Markdown,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

export interface AssistantTextView extends Component {
  dispose?(): void;
  setText(text: string): void;
}

/**
 * Render a text fragment through the next inner renderer in a composed
 * fallback chain. The host wires this; renderers fall back to plain Markdown
 * when it is absent (for example in unit tests).
 */
export type AssistantRendererDelegate = (text: string) => AssistantTextView;

export interface AssistantRendererContext {
  readonly delegate?: AssistantRendererDelegate;
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

/**
 * Compose fallback assistant renderers into one renderer. Renderers are given
 * in registration order; the last registered renderer is outermost and each
 * renderer's `delegate` context property renders through the next inner one,
 * bottoming out at the plain Markdown view the TUI uses without extensions.
 */
export const composeAssistantRenderers = (
  renderers: readonly AssistantRenderer[]
): AssistantRenderer | undefined => {
  if (renderers.length === 0) {
    return;
  }
  return (context) => {
    const createView = (
      index: number,
      notifyOutward: () => void
    ): AssistantTextView => {
      if (index < 0) {
        return new Markdown("", 1, 0, context.markdownTheme);
      }
      const renderer = renderers[index];
      if (renderer === undefined) {
        return createView(index - 1, notifyOutward);
      }
      let self: AssistantTextView | undefined;
      // An async inner render (image ready) must drop every outer cached
      // frame before the TUI repaints, or the update never becomes visible.
      const requestRender = (): void => {
        self?.invalidate();
        notifyOutward();
      };
      const view = renderer({
        ...context,
        delegate: (text) => {
          const inner = createView(index - 1, requestRender);
          inner.setText(text);
          return inner;
        },
        requestRender,
      });
      self = view;
      return view;
    };
    return createView(renderers.length - 1, context.requestRender);
  };
};

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
