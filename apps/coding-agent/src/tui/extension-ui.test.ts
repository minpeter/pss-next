import type {
  Component,
  Container,
  Input,
  SelectList,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createExtensionUi } from "./extension-ui";

const fixture = () => {
  const mounted: Component[] = [];
  const controller = new AbortController();
  const showMessage = vi.fn();
  const showStatus = vi.fn(() => () => undefined);
  const unmounted = vi.fn();
  const ui = createExtensionUi({
    promptHost: {
      mount: (component) => {
        mounted.push(component);
        return unmounted;
      },
    },
    showMessage,
    showStatus,
    signal: controller.signal,
  });
  return { controller, mounted, showMessage, showStatus, ui, unmounted };
};

describe("extension inline TUI service", () => {
  it("settles input once and releases its composer slot", async () => {
    const f = fixture();
    const result = f.ui.input({ initialValue: "draft", label: "Name" });
    const input = (f.mounted[0] as Container).children[1] as Input;
    input.onSubmit?.("chosen");
    input.onEscape?.();
    await expect(result).resolves.toBe("chosen");
    expect(f.unmounted).toHaveBeenCalledTimes(1);
  });
  it("ignores key releases before choosing the selected value", async () => {
    const f = fixture();
    const result = f.ui.select({
      label: "Model",
      options: [
        { label: "Fast", value: "fast" },
        { label: "Slow", value: "slow" },
      ],
    });
    const prompt = f.mounted[0];
    prompt.handleInput?.("\x1b[13;1:3u");
    expect(f.unmounted).not.toHaveBeenCalled();
    prompt.handleInput?.("\x1b[B");
    prompt.handleInput?.("\r");
    await expect(result).resolves.toBe("slow");
  });
  it("settles cancellation on lifecycle abort and ignores retained selection callbacks", async () => {
    const f = fixture();
    const result = f.ui.select({
      label: "Model",
      options: [{ label: "Fast", value: "fast" }],
    });
    const list = (f.mounted[0] as Container).children[1] as SelectList;
    f.controller.abort();
    list.onSelect?.({ label: "Fast", value: "fast" });
    await expect(result).resolves.toBeUndefined();
    expect(f.unmounted).toHaveBeenCalledTimes(1);
  });
  it("does not open prompts or publish notices/status after host abort", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.ui.input({ label: "Aborted" })).resolves.toBeUndefined();
    f.ui.notify("stale");
    f.ui.status("stale")();
    expect(f.mounted).toHaveLength(0);
    expect(f.showMessage).not.toHaveBeenCalled();
    expect(f.showStatus).not.toHaveBeenCalled();
  });
  it.each(["\x1b", "\x03"])("cancels with %j", async (key) => {
    const f = fixture();
    const result = f.ui.confirm("Confirm?");
    f.mounted[0].handleInput?.(key);
    await expect(result).resolves.toBe(false);
  });
});
