import {
  Container,
  Input,
  Key,
  matchesKey,
  SelectList,
  Text,
  type TUI,
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

export function createExtensionUi(options: {
  readonly restoreFocus: () => void;
  readonly showMessage: (message: string) => void;
  readonly showStatus: (message: string) => () => void;
  readonly signal: AbortSignal;
  readonly tui: TUI;
}): CodingAgentExtensionUi {
  const ui: CodingAgentExtensionUi = {
    confirm: async (message: string) =>
      (await selectValue(options, {
        label: message,
        options: [
          { label: "Confirm", value: "confirm" },
          { label: "Cancel", value: "cancel" },
        ],
      })) === "confirm",
    input: async ({
      initialValue,
      label,
    }: {
      readonly initialValue?: string;
      readonly label: string;
    }) => await inputValue(options, label, initialValue),
    notify: (message: string) =>
      options.showMessage(sanitizeTerminalText(message)),
    select: async ({
      label,
      options: values,
    }: {
      readonly label: string;
      readonly options: readonly {
        readonly description?: string;
        readonly label: string;
        readonly value: string;
      }[];
    }) => await selectValue(options, { label, options: values }),
    status: (message: string) =>
      options.showStatus(sanitizeTerminalText(message)),
  };
  return Object.freeze(ui);
}

async function inputValue(
  options: Parameters<typeof createExtensionUi>[0],
  label: string,
  initialValue: string | undefined
): Promise<string | undefined> {
  if (options.signal.aborted) {
    return;
  }
  const sanitizedLabel = requiredLabel(label);
  return await new Promise<string | undefined>((resolve) => {
    const container = new Container();
    const input = new Input();
    let settled = false;
    let handle: ReturnType<typeof options.tui.showOverlay>;
    const settle = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal.removeEventListener("abort", abort);
      handle.hide();
      options.restoreFocus();
      resolve(value);
    };
    const abort = () => settle(undefined);
    container.addChild(new Text(sanitizedLabel, 1, 0));
    container.addChild(input);
    input.setValue(initialValue ?? "");
    input.onEscape = () => settle(undefined);
    input.onSubmit = (value) => settle(value);
    handle = options.tui.showOverlay(container, { minWidth: 32, width: "60%" });
    options.signal.addEventListener("abort", abort, { once: true });
    options.tui.setFocus(input);
    options.tui.requestRender();
  });
}

async function selectValue(
  options: Parameters<typeof createExtensionUi>[0],
  input: {
    readonly label: string;
    readonly options: readonly {
      readonly description?: string;
      readonly label: string;
      readonly value: string;
    }[];
  }
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
  return await new Promise<string | undefined>((resolve) => {
    const container = new Container();
    const list = new SelectList(items, 8, selectTheme);
    let settled = false;
    let handle: ReturnType<typeof options.tui.showOverlay>;
    let removeInput: () => void = () => undefined;
    const settle = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal.removeEventListener("abort", abort);
      removeInput();
      handle.hide();
      options.restoreFocus();
      resolve(value);
    };
    const abort = () => settle(undefined);
    container.addChild(new Text(label, 1, 0));
    container.addChild(list);
    list.onCancel = () => settle(undefined);
    list.onSelect = (selected) => settle(selected.value);
    handle = options.tui.showOverlay(container, { minWidth: 32, width: "60%" });
    removeInput = options.tui.addInputListener((data) => {
      if (matchesKey(data, Key.escape)) {
        settle(undefined);
      } else {
        list.handleInput(data);
      }
      return { consume: true };
    });
    options.signal.addEventListener("abort", abort, { once: true });
    handle.focus();
    options.tui.requestRender();
  });
}

function requiredLabel(value: string): string {
  const label = sanitizeTerminalText(value).trim();
  if (label.length === 0) {
    throw new TypeError("Extension UI label must not be empty");
  }
  return label;
}
