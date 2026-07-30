import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { composerFlowLines } from "./composer-flow";

const WIDTH = 20;

const lines = (count: number, label: string): Container => {
  const container = new Container();
  for (let index = 0; index < count; index += 1) {
    container.addChild(new Text(`${label}-${index}`, 0, 0));
  }
  return container;
};

const trimmed = (rendered: readonly string[]): string[] =>
  rendered.map((line) => line.trimEnd());

describe("composerFlowLines", () => {
  it("places the composer right below short content", () => {
    const rendered = composerFlowLines({
      chat: lines(2, "chat"),
      composer: lines(3, "composer"),
      header: lines(4, "header"),
      terminalRows: 40,
      width: WIDTH,
    });

    expect(trimmed(rendered)).toEqual([
      "header-0",
      "header-1",
      "header-2",
      "header-3",
      "chat-0",
      "chat-1",
      "composer-0",
      "composer-1",
      "composer-2",
    ]);
  });

  it("keeps the composer last once content exceeds the viewport", () => {
    const rendered = composerFlowLines({
      chat: lines(50, "chat"),
      composer: lines(3, "composer"),
      header: lines(2, "header"),
      terminalRows: 24,
      width: WIDTH,
    });

    expect(rendered).toHaveLength(55);
    expect(trimmed(rendered).slice(-4)).toEqual([
      "chat-49",
      "composer-0",
      "composer-1",
      "composer-2",
    ]);
  });
});
