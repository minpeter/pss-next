export type {
  AssistantRenderer,
  AssistantRendererContext,
  AssistantRendererRegistrationOptions,
  AssistantTextView,
} from "@minpeter/pss-extension-api";

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
