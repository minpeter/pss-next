import {
  type Component,
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-safety";

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_GRAY = "\x1b[90m";

const style = (prefix: string, text: string): string =>
  `${prefix}${text}${ANSI_RESET}`;

const MAX_VISIBLE_MODELS = 10;

const clampVisibleModels = (maxVisibleModels: number | undefined): number =>
  Math.max(
    1,
    Math.min(
      MAX_VISIBLE_MODELS,
      Math.floor(maxVisibleModels ?? MAX_VISIBLE_MODELS)
    )
  );

class ModelRow implements Component {
  readonly #current: boolean;
  readonly #id: string;
  readonly #selected: boolean;

  constructor(id: string, current: boolean, selected: boolean) {
    this.#id = sanitizeTerminalText(id);
    this.#current = current;
    this.#selected = selected;
  }

  invalidate(): void {
    // Stateless; nothing to invalidate.
  }

  render(width: number): string[] {
    const prefix = this.#selected ? "→ " : "  ";
    const suffix = this.#current ? " ✓" : "";
    // Account for Text's former left padding and truncate the provider label
    // before styling so each catalog id always consumes one visual row.
    const labelWidth = Math.max(
      0,
      width - 1 - visibleWidth(prefix) - visibleWidth(suffix)
    );
    const label = truncateToWidth(this.#id, labelWidth);
    const line = this.#selected
      ? `${style(ANSI_CYAN, prefix)}${style(ANSI_CYAN, label)}${this.#current ? style(ANSI_GREEN, suffix) : ""}`
      : `${prefix}${label}${this.#current ? style(ANSI_GREEN, suffix) : ""}`;
    return [truncateToWidth(` ${line}`, width)];
  }
}

/** Full-width dim horizontal rule, like pi's selector borders. */
class HorizontalRule implements Component {
  invalidate(): void {
    // Stateless; nothing to invalidate.
  }

  render(width: number): string[] {
    return [style(ANSI_GRAY, "─".repeat(Math.max(0, width)))];
  }
}

export interface ModelSelectorOptions {
  /** Removes decorative spacing on a very short terminal. */
  readonly compact?: boolean;
  readonly currentModelId: string;
  /** Initial fuzzy-search text, for example from `/model <query>`. */
  readonly initialQuery?: string;
  /** Maximum number of model rows visible at once. */
  readonly maxVisibleModels?: number;
  readonly modelIds: readonly string[];
  readonly onCancel: () => void;
  readonly onSelect: (modelId: string) => void;
}

/**
 * pi-style inline model selector: swapped into the editor slot (not a
 * floating overlay) and driven through the TUI's focused-component input
 * path, which filters Kitty key releases and re-renders after every key.
 *
 * Layout mirrors pi's `/model` picker: bordered panel, fuzzy-search input,
 * a windowed list with `→` selection, `✓` on the current model, and a
 * `(n/m)` scroll indicator.
 */
export class ModelSelectorComponent extends Container {
  #filtered: readonly string[];
  readonly #models: readonly string[];
  readonly #currentModelId: string;
  readonly #listContainer = new Container();
  readonly #onCancel: () => void;
  readonly #onSelect: (modelId: string) => void;
  readonly #searchInput = new Input();
  readonly #title: Text;
  #compact: boolean;
  #maxVisibleModels: number;
  #selectedIndex = 0;
  #settled = false;

  // Focusable: propagate to the search input so the cursor renders there.
  #focused = false;

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#searchInput.focused = value;
  }

  constructor(options: ModelSelectorOptions) {
    super();
    this.#currentModelId = options.currentModelId;
    this.#onCancel = options.onCancel;
    this.#onSelect = options.onSelect;
    this.#compact = options.compact ?? false;
    this.#maxVisibleModels = clampVisibleModels(options.maxVisibleModels);
    // Current model first, then the provider's catalog order.
    this.#models = [
      ...options.modelIds.filter((id) => id === options.currentModelId),
      ...options.modelIds.filter((id) => id !== options.currentModelId),
    ];
    this.#filtered = this.#models;
    this.#title = new Text(
      `${style(ANSI_BOLD, "Select a model")} ${style(ANSI_DIM, `— current: ${sanitizeTerminalText(options.currentModelId)} · type to search · enter to select · esc to cancel`)}`,
      1,
      0
    );
    // Input#setValue preserves its old cursor (zero on a fresh Input), so
    // replay the initial query through normal insertion to place it at end.
    this.#searchInput.handleInput(options.initialQuery ?? "");
    this.#searchInput.onSubmit = () => this.#confirmSelection();
    this.#searchInput.onEscape = () => this.#cancel();
    this.#rebuildLayout();
    this.#applyFilter(this.#searchInput.getValue());
  }

  /** Recalculate the selector layout after a terminal-height change. */
  setLayout(maxVisibleModels: number, compact: boolean): void {
    const next = clampVisibleModels(maxVisibleModels);
    if (next === this.#maxVisibleModels && compact === this.#compact) {
      return;
    }
    this.#maxVisibleModels = next;
    this.#compact = compact;
    this.#rebuildLayout();
    this.#updateList();
  }

  setMaxVisibleModels(maxVisibleModels: number): void {
    this.setLayout(maxVisibleModels, this.#compact);
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.up")) {
      this.#moveSelection(-1);
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      this.#moveSelection(1);
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      this.#confirmSelection();
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.#cancel();
      return;
    }
    // Everything else edits the fuzzy search query.
    this.#searchInput.handleInput(data);
    this.#applyFilter(this.#searchInput.getValue());
  }

  #rebuildLayout(): void {
    this.clear();
    if (!this.#compact) {
      this.addChild(new HorizontalRule());
      this.addChild(new Spacer(1));
    }
    this.addChild(this.#title);
    if (!this.#compact) {
      this.addChild(new Spacer(1));
    }
    this.addChild(this.#searchInput);
    if (!this.#compact) {
      this.addChild(new Spacer(1));
    }
    this.addChild(this.#listContainer);
    if (!this.#compact) {
      this.addChild(new Spacer(1));
      this.addChild(new HorizontalRule());
    }
  }

  #moveSelection(delta: number): void {
    const count = this.#filtered.length;
    if (count === 0) {
      return;
    }
    this.#selectedIndex = (this.#selectedIndex + delta + count) % count;
    this.#updateList();
  }

  #confirmSelection(): void {
    const selected = this.#filtered[this.#selectedIndex];
    if (selected === undefined || this.#settled) {
      return;
    }
    this.#settled = true;
    this.#onSelect(selected);
  }

  #cancel(): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#onCancel();
  }

  #applyFilter(query: string): void {
    this.#filtered = query
      ? fuzzyFilter(
          this.#models.map((id) => ({ id })),
          query,
          ({ id }) => id
        ).map(({ id }) => id)
      : this.#models;
    this.#selectedIndex = Math.min(
      this.#selectedIndex,
      Math.max(0, this.#filtered.length - 1)
    );
    this.#updateList();
  }

  #updateList(): void {
    this.#listContainer.clear();
    if (this.#filtered.length === 0) {
      this.#listContainer.addChild(
        new Text(style(ANSI_DIM, "  No matching models"), 1, 0)
      );
      return;
    }

    const start = Math.max(
      0,
      Math.min(
        this.#selectedIndex - Math.floor(this.#maxVisibleModels / 2),
        this.#filtered.length - this.#maxVisibleModels
      )
    );
    const end = Math.min(start + this.#maxVisibleModels, this.#filtered.length);

    for (let index = start; index < end; index++) {
      const id = this.#filtered[index];
      if (id === undefined) {
        continue;
      }
      this.#listContainer.addChild(
        new ModelRow(
          id,
          id === this.#currentModelId,
          index === this.#selectedIndex
        )
      );
    }

    if (start > 0 || end < this.#filtered.length) {
      this.#listContainer.addChild(
        new Text(
          style(
            ANSI_DIM,
            `  (${this.#selectedIndex + 1}/${this.#filtered.length})`
          ),
          1,
          0
        )
      );
    }
  }
}
