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

## Publish built-in extensions as installable packages

First publish of the three built-in extensions with their publishable manifests (no private flag, concrete peer ranges), enabling `pss extension install`/`update` to deliver them between coding-agent releases.
