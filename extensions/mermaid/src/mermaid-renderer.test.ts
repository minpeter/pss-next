import { describe, expect, it } from "vitest";
import { renderMermaidArt } from "./mermaid-renderer";

const gridExplosionSource = (hops: number): string =>
  `graph LR\n${Array.from({ length: hops }, (_, i) => `N${i} --> N${i + 1}`).join("\n")}`;

describe("renderMermaidArt queue bounds", () => {
  it("resolves undefined instead of queueing beyond the in-flight cap", async () => {
    const controller = new AbortController();
    const source = gridExplosionSource(40);
    const pending = Array.from({ length: 33 }, () =>
      renderMermaidArt(source, controller.signal).catch(() => undefined)
    );
    const overflow = await renderMermaidArt(source, controller.signal);

    expect(overflow).toBeUndefined();
    controller.abort();
    await Promise.all(pending);
  }, 60_000);

  it("keeps rendering after a worker was destroyed by a pathological job", async () => {
    await renderMermaidArt(gridExplosionSource(40)).catch(() => undefined);
    const art = await renderMermaidArt("graph LR\nA-->B");

    expect(art?.join("\n")).toContain("A");
  }, 60_000);
});
