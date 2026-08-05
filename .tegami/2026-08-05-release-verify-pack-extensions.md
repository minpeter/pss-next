---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Pack all extensions in the release dependency check

Pack the latex and mermaid extensions alongside web in the release
workflow's coding-agent dependency resolution check, fixing the npm E404
on the never-published @minpeter/pss-extension-mermaid.
