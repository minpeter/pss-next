import type { Container, Input, SelectList, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createExtensionUi } from "./extension-ui";

interface FakeTui {
  readonly addInputListener: (
    listener: (input: string) => unknown
  ) => () => void;
  readonly requestRender: () => void;
  readonly setFocus: (component: unknown) => void;
  readonly showOverlay: (component: Container) => {
    focus(): void;
    hide(): void;
  };
}

const createFakeTui = () => {
  const overlays: Container[] = [];
  const listeners: ((input: string) => unknown)[] = [];
  let hidden = 0;
  let restored = 0;
  const tui: FakeTui = {
    addInputListener: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    requestRender: () => undefined,
    setFocus: () => undefined,
    showOverlay: (component) => {
      overlays.push(component);
      return {
        focus: () => undefined,
        hide: () => {
          hidden += 1;
        },
      };
    },
  };
  const controller = new AbortController();
  const ui = createExtensionUi({
    restoreFocus: () => {
      restored += 1;
    },
    showMessage: () => undefined,
    showStatus: () => () => undefined,
    signal: controller.signal,
    tui: tui as unknown as TUI,
  });
  return {
    controller,
    hidden: () => hidden,
    listeners,
    overlays,
    restored: () => restored,
    ui,
  };
};

describe("extension TUI service", () => {
  it("settles input once and restores focus", async () => {
    const fixture = createFakeTui();
    const result = fixture.ui.input({ initialValue: "draft", label: "Name" });
    const input = fixture.overlays[0]?.children[1] as Input;

    input.onSubmit?.("chosen");
    input.onEscape?.();

    await expect(result).resolves.toBe("chosen");
    expect(fixture.hidden()).toBe(1);
    expect(fixture.restored()).toBe(1);
  });

  it("settles select cancellation on lifecycle abort and removes input routing", async () => {
    const fixture = createFakeTui();
    const result = fixture.ui.select({
      label: "Model",
      options: [{ label: "Fast", value: "fast" }],
    });
    const list = fixture.overlays[0]?.children[1] as SelectList;

    expect(fixture.listeners).toHaveLength(1);
    fixture.controller.abort();
    list.onSelect?.({ label: "Fast", value: "fast" });

    await expect(result).resolves.toBeUndefined();
    expect(fixture.listeners).toHaveLength(0);
    expect(fixture.hidden()).toBe(1);
    expect(fixture.restored()).toBe(1);
  });

  it("does not open a dialog after the TUI lifecycle is already aborted", async () => {
    const fixture = createFakeTui();
    fixture.controller.abort();

    const result = await Promise.race([
      fixture.ui.input({ label: "Aborted" }),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("pending"), 0);
      }),
    ]);

    expect(result).toBeUndefined();
    expect(fixture.overlays).toHaveLength(0);
  });
});
