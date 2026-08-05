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

## Publish built-in extensions to the latest dist-tag

The extension manager resolves tagless installs through `latest`, so the built-in extensions now publish there instead of `next`; this release also moves `latest` off the stale pre-#335 builds.
