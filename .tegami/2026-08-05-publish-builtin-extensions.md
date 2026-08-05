---
packages:
  npm:@minpeter/pss-extension-latex:
    type: patch
  npm:@minpeter/pss-extension-mermaid:
    type: patch
  npm:@minpeter/pss-extension-web:
    type: patch
---

## Publish built-in extensions as installable packages

First publish of the three built-in extensions with their publishable manifests (no private flag, concrete peer ranges), enabling `pss extension install`/`update` to deliver them between coding-agent releases.
