---
packages:
  npm:@minpeter/pss-extension-latex:
    type: patch
  npm:@minpeter/pss-extension-mermaid:
    type: patch
  npm:@minpeter/pss-extension-web:
    type: patch
---

## Publish built-in extensions to the latest dist-tag

The extension manager resolves tagless installs through `latest`, so the built-in extensions now publish there instead of `next`; this release also moves `latest` off the stale pre-#335 builds.
