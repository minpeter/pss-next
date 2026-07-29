import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  sessionDisplayLabel,
  sessionUpdatedLabel,
} from "../sessions/session-display";
import type { SessionIndexEntry } from "../sessions/session-index";
import { sanitizeTerminalText } from "./terminal-safety";

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_DIM = "\x1b[2m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_GREEN = "\x1b[32m";

const style = (prefix: string, text: string): string =>
  `${prefix}${text}${ANSI_RESET}`;

export class SessionSelectorRule implements Component {
  invalidate(): void {
    return;
  }

  render(width: number): string[] {
    return [style(ANSI_GRAY, "─".repeat(Math.max(0, width)))];
  }
}

export class SessionSelectorTitle implements Component {
  invalidate(): void {
    return;
  }

  render(width: number): string[] {
    const title = `${style(ANSI_BOLD, "Resume a session")} ${style(ANSI_DIM, "— type to search · enter to resume · esc to cancel")}`;
    return [truncateToWidth(title, width)];
  }
}

export class SessionSelectorRow implements Component {
  readonly #current: boolean;
  readonly #entry: SessionIndexEntry;
  readonly #selected: boolean;

  constructor(entry: SessionIndexEntry, current: boolean, selected: boolean) {
    this.#entry = entry;
    this.#current = current;
    this.#selected = selected;
  }

  invalidate(): void {
    return;
  }

  render(width: number): string[] {
    const prefix = this.#selected ? "→ " : "  ";
    const suffix = this.#current ? " ✓" : "";
    const content = `${sanitizeTerminalText(sessionDisplayLabel(this.#entry))}  ${sessionUpdatedLabel(this.#entry)}`;
    const contentWidth = Math.max(
      0,
      width - 1 - visibleWidth(prefix) - visibleWidth(suffix)
    );
    const line = `${prefix}${truncateToWidth(content, contentWidth)}`;
    return [
      this.#selected
        ? `${style(ANSI_CYAN, ` ${line}`)}${this.#current ? style(ANSI_GREEN, suffix) : ""}`
        : ` ${line}${this.#current ? style(ANSI_GREEN, suffix) : ""}`,
    ];
  }
}
