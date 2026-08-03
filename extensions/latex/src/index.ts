import {
  assistantRenderer,
  type CodingAgentExtensionFactory,
  instructions,
} from "@minpeter/pss-coding-agent/extension";
import { LatexMarkdown } from "./latex-markdown";

export const LATEX_OUTPUT_INSTRUCTIONS = `Format mathematical notation consistently in user-facing responses:
- Use $...$ only for short inline variables and compact expressions that belong inside a prose sentence.
- Put standalone equations, fractions, derivations, matrices, cases, arrays, and other non-trivial notation in complete Markdown display blocks using $$ delimiters on their own lines.
- Keep explanatory prose outside display delimiters, and close every display block before continuing.
- Do not use \\(...\\) or \\[...\\] delimiters; use $...$ for inline math and $$...$$ for display math.
- In cases, matrices, aligned equations, and arrays, terminate each row with two literal backslash characters (\\\\), never one.
- Do not put an equation in a fenced code block; use a fenced block only when demonstrating literal LaTeX source.`;

const missingDependencyMessage = (executable: string): string => {
  const dependency =
    executable === "convert"
      ? "ImageMagick (`magick` or `convert`)"
      : `\`${executable}\``;
  return `LaTeX display math is unavailable because ${dependency} was not found. Install the optional LaTeX dependencies; the original Markdown will be shown for now.`;
};

export const createLatexExtension: CodingAgentExtensionFactory = (pss) => {
  pss.provide(instructions(LATEX_OUTPUT_INSTRUCTIONS));
  pss.provide(
    assistantRenderer(
      ({ foregroundColor, markdownTheme, notifyOnce, requestRender, signal }) =>
        new LatexMarkdown("", 1, 0, markdownTheme, {
          foregroundColor,
          onMissingTool(executable) {
            notifyOnce(
              "latex:missing-dependency",
              missingDependencyMessage(executable)
            );
          },
          requestRender,
          signal,
        }),
      { fallback: true }
    )
  );
};

const createDefaultLatexExtension: CodingAgentExtensionFactory = (pss) =>
  createLatexExtension(pss);

export default createDefaultLatexExtension;
