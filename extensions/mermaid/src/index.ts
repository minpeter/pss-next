import {
  assistantRenderer,
  type CodingAgentExtensionFactory,
  instructions,
} from "@minpeter/pss-coding-agent/extension";
import { MermaidMarkdown } from "./mermaid-markdown";

export const MERMAID_OUTPUT_INSTRUCTIONS = `Format diagrams consistently in user-facing responses:
- Put every Mermaid diagram in a complete fenced code block tagged \`\`\`mermaid on its own line, and close the fence before continuing with prose.
- Keep one diagram per fence and all explanatory prose outside the fence.
- Write only valid Mermaid source inside the fence; do not nest code fences, Markdown, or non-Mermaid comments inside it.
- Prefer flowcharts (graph TD or graph LR) or sequence diagrams unless another diagram type is clearly a better fit.`;

export const createMermaidExtension: CodingAgentExtensionFactory = (pss) => {
  pss.provide(instructions(MERMAID_OUTPUT_INSTRUCTIONS));
  pss.provide(
    assistantRenderer(
      ({ delegate, markdownTheme, requestRender, signal }) =>
        new MermaidMarkdown("", 1, 0, markdownTheme, {
          delegate,
          requestRender,
          signal,
        }),
      { fallback: true }
    )
  );
};

const createDefaultMermaidExtension: CodingAgentExtensionFactory = (pss) =>
  createMermaidExtension(pss);

export default createDefaultMermaidExtension;
