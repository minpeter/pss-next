---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Bundle built-in extensions into the coding agent

Ship the LaTeX, Mermaid, and web extensions inside the coding-agent tarball
via tsdown alwaysBundle instead of publishing them as separate npm packages,
so adding a built-in extension no longer requires a new published package.
Only pss-runtime and pss-coding-agent remain published.
