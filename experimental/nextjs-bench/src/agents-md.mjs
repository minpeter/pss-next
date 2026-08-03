/**
 * The AGENTS.md the official Next.js eval variant writes into the sandbox.
 * The upstream experiments produce the "with AGENTS.md" column by dropping
 * this file at the workspace root, so parity requires the same content.
 */
export const AGENTS_MD_CONTENT = `<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in \`node_modules/next/dist/docs/\` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
`;

export function agentsMdFiles(agentsMd) {
  return agentsMd ? { "AGENTS.md": AGENTS_MD_CONTENT } : {};
}

/** Results path for a campaign; the variant is kept separate from the baseline so the two are never scored into the same directory. */
export function resolveExperimentName({ agentsMd, model, profile }) {
  return `pss-${profile}${agentsMd ? "--agents-md" : ""}/${model}`;
}
