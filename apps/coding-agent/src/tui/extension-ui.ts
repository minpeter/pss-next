import {
  type Component,
  Container,
  Input,
  isFocusable,
  isKeyRelease,
  Key,
  matchesKey,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import type { CodingAgentExtensionUi } from "../extensions/types";
import { sanitizeTerminalText } from "./terminal-safety";

const selectTheme = {
  description: (text: string) => text,
  noMatch: (text: string) => text,
  scrollInfo: (text: string) => text,
  selectedPrefix: (text: string) => `> ${text}`,
  selectedText: (text: string) => text,
};

/** Prompts share the HOT composer slot, never a screen overlay. */
export interface ExtensionPromptHost {
  mount(component: Component): () => void;
}

class InlinePrompt extends Container {
  readonly #input: Component;
  readonly #cancel: () => void;
  #focused = false;

  constructor(label: string, input: Component, cancel: () => void) {
    super();
    this.#input = input;
    this.#cancel = cancel;
    this.addChild(new Text(label, 1, 0));
    this.addChild(input);
  }

  get focused(): boolean {
    return this.#focused;
  }
  set focused(value: boolean) {
    this.#focused = value;
    if (isFocusable(this.#input)) {
      this.#input.focused = value;
    }
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) {
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.#cancel();
    } else {
      this.#input.handleInput?.(data);
    }
  }
}

interface UiOptions {
  readonly onUserWait?: () => () => void;
  readonly promptHost: ExtensionPromptHost;
  readonly promptSignal?: () => AbortSignal;
  readonly showMessage: (message: string) => void;
  readonly showStatus: (message: string) => () => void;
  readonly signal: AbortSignal;
}

export function createExtensionUi(options: UiOptions): CodingAgentExtensionUi {
  const ui: CodingAgentExtensionUi = {
    confirm: async (message) =>
      (await selectValue(options, {
        label: message,
        options: [
          { label: "Confirm", value: "confirm" },
          { label: "Cancel", value: "cancel" },
        ],
      })) === "confirm",
    input: async ({ initialValue, label }) => {
      if (options.signal.aborted) {
        return;
      }
      const input = new Input();
      input.setValue(initialValue ?? "");
      return await prompt(options, requiredLabel(label), input, (settle) => {
        input.onEscape = () => settle(undefined);
        input.onSubmit = settle;
      });
    },
    notify: (message) => {
      if (!options.signal.aborted) {
        options.showMessage(sanitizeTerminalText(message));
      }
    },
    select: async (input) => await selectValue(options, input),
    status: (message) =>
      options.signal.aborted
        ? () => undefined
        : options.showStatus(sanitizeTerminalText(message)),
  };
  return Object.freeze(ui);
}

async function prompt(
  options: UiOptions,
  label: string,
  input: Component,
  configure: (settle: (value: string | undefined) => void) => void
): Promise<string | undefined> {
  const signal = options.promptSignal?.() ?? options.signal;
  if (signal.aborted) {
    return;
  }
  const resume = options.onUserWait?.();
  try {
    return await new Promise<string | undefined>((resolve) => {
      let settled = false;
      let unmount: () => void = () => undefined;
      const settle = (value: string | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        unmount();
        resolve(value);
      };
      const abort = () => settle(undefined);
      configure(settle);
      unmount = options.promptHost.mount(new InlinePrompt(label, input, abort));
      signal.addEventListener("abort", abort, { once: true });
    });
  } finally {
    resume?.();
  }
}

async function selectValue(
  options: UiOptions,
  input: Parameters<CodingAgentExtensionUi["select"]>[0]
): Promise<string | undefined> {
  if (options.signal.aborted) {
    return;
  }
  const label = requiredLabel(input.label);
  if (input.options.length === 0 || input.options.length > 100) {
    throw new TypeError(
      "Extension UI select must provide between 1 and 100 options"
    );
  }
  const values = new Set<string>();
  const items = input.options.map((option) => {
    if (
      typeof option.value !== "string" ||
      typeof option.label !== "string" ||
      option.value.length === 0 ||
      values.has(option.value)
    ) {
      throw new TypeError(
        "Extension UI select options must have unique values"
      );
    }
    values.add(option.value);
    return {
      ...(option.description === undefined
        ? {}
        : { description: sanitizeTerminalText(option.description) }),
      label: sanitizeTerminalText(option.label),
      value: option.value,
    };
  });
  const list = new SelectList(items, 8, selectTheme);
  return await prompt(options, label, list, (settle) => {
    list.onCancel = () => settle(undefined);
    list.onSelect = (selected) => settle(selected.value);
  });
}

function requiredLabel(value: string): string {
  const label = sanitizeTerminalText(value).trim();
  if (label.length === 0) {
    throw new TypeError("Extension UI label must not be empty");
  }
  return label;
}
