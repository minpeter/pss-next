---
packages:
  npm:@minpeter/pss-extension-latex:
    type: patch
  npm:@minpeter/pss-extension-mermaid:
    type: patch
  npm:@minpeter/pss-extension-web:
    type: patch
---

## Declare the coding agent dependency in extensions

Add @minpeter/pss-coding-agent as a dev dependency of the LaTeX, Mermaid, and web extensions so Turborepo 2.10.8 boundaries accepts the /extension imports.
