// Visual preview of the composed assistant renderer (LaTeX + Mermaid):
// `pnpm preview:assistant`. Prints one frame after both images resolve.
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { createCodingAgentExtensionHostWithDefaults } from "../src/extensions/defaults";

const plainTheme: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => t,
  bold: (t) => t,
  italic: (t) => t,
  strikethrough: (t) => t,
  underline: (t) => t,
};

const KITTY_SEQUENCE = "\u001b_G";
const RENDER_TIMEOUT_MS = 30_000;

const text = [
  "Here are the quadratic formula and the request flow:",
  "",
  "$$",
  String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
  "$$",
  "",
  "```mermaid",
  "graph TD;",
  "  subgraph client[클라이언트]",
  "    A[사용자 입력] --> B[pss TUI];",
  "  end;",
  "  B --> C[createCodingAgent];",
  "  C --> D[createAgent 런타임];",
  "  C --> E[도구 병합];",
  "  E --> F[workspace-tools];",
  "  E --> G[web_search/web_fetch];",
  "```",
  "",
  "Both blocks render inline above.",
].join("\n");

const main = async (): Promise<void> => {
  const host = await createCodingAgentExtensionHostWithDefaults([], {
    web: false,
  });
  try {
    const width = Math.min(process.stdout.columns || 100, 120);
    let notifyReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    const view = host.assistantRenderer?.({
      markdownTheme: plainTheme,
      notify: (message) => process.stderr.write(`${message}\n`),
      notifyOnce: (_key, message) => process.stderr.write(`${message}\n`),
      requestRender: () => {
        const output = view?.render(width).join("\n") ?? "";
        const imagesReady =
          output.includes(KITTY_SEQUENCE) &&
          output.includes("┌") &&
          !output.includes("x =");
        if (imagesReady) {
          notifyReady?.();
        }
      },
      signal: host.signal,
    });
    if (view === undefined) {
      throw new Error("assistant renderer is unavailable");
    }
    view.setText(text);
    view.render(width);
    const winner = await Promise.race([
      ready.then(() => "ready" as const),
      new Promise((resolve) => {
        setTimeout(() => resolve("timeout" as const), RENDER_TIMEOUT_MS);
      }),
    ]);
    const lines = view.render(width);
    process.stdout.write(
      `\nassistant renderer preview — width ${width}\n\n${lines.join("\n")}\n`
    );
    const imageLines = lines.filter((line) => line.includes(KITTY_SEQUENCE));
    const metadata = {
      formulas: 1,
      images: imageLines.map((line) => ({ margin: line.startsWith(" ") })),
    };
    process.stdout.write(`__PSS_QA_META__${JSON.stringify(metadata)}\n`);
    view.dispose?.();
    if (winner === "timeout") {
      process.stderr.write("timed out waiting for both renders\n");
      process.exitCode = 1;
    }
  } finally {
    await host.dispose();
  }
};

await main();
