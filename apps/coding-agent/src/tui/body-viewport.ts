import {
  type Component,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
  type ColdContent,
  captureComponent,
  selectColdTail,
} from "./cold-content";

const BODY_ROWS = 8;

/** Render-only tail window; never shorten the component's underlying source. */
export const renderBodyTail = (lines: string[], width: number): string[] => {
  // Graphics transmissions and their reserved rows are atomic. The text viewport
  // does not support clipping Kitty, iTerm2, or DCS (including sixel) graphics.
  if (
    lines.some(
      (line) =>
        line.includes("\x1b_G") ||
        line.includes("\x1b]1337;File=") ||
        line.includes("\x1bP")
    )
  ) {
    return lines;
  }
  if (lines.length === 0) {
    return [];
  }
  return wrapTextWithAnsi(lines.join("\n"), Math.max(1, width))
    .slice(-BODY_ROWS)
    .map((line) => truncateToWidth(line, width, ""));
};

export class BodyViewport implements Component {
  private readonly child: Component;

  constructor(child: Component) {
    this.child = child;
  }

  captureCold(width: number): ColdContent {
    return selectColdTail(
      captureComponent(this.child, width),
      width,
      BODY_ROWS
    );
  }

  invalidate(): void {
    this.child.invalidate();
  }

  render(width: number): string[] {
    return renderBodyTail(this.child.render(width), width);
  }
}
