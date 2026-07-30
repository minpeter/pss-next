import type { Component } from "@earendil-works/pi-tui";

export interface ComposerFlowOptions {
  readonly chat: Component;
  readonly composer: Component;
  readonly header: Component;
  readonly terminalRows: number;
  readonly width: number;
}

export const composerFlowLines = ({
  chat,
  composer,
  header,
  width,
}: ComposerFlowOptions): readonly string[] => [
  ...header.render(width),
  ...chat.render(width),
  ...composer.render(width),
];
