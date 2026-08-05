---
packages:
  npm:@minpeter/pss-extension-latex:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-latex)
  npm:@minpeter/pss-extension-mermaid:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-mermaid)
  npm:@minpeter/pss-extension-web:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-web)
---

## Declare the coding agent dependency in extensions

Add @minpeter/pss-coding-agent as a dev dependency of the LaTeX, Mermaid, and web extensions so Turborepo 2.10.8 boundaries accepts the /extension imports.
