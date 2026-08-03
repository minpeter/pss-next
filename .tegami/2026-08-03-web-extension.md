---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
  npm:@minpeter/pss-extension-web:
    replay:
      - exit-prerelease(npm:@minpeter/pss-extension-web)
---

## Extract the coding agent's web tools into an extension

Move `web_search`, `web_fetch`, their OpenSearch integration, and TUI renderers
into a default `@minpeter/pss-extension-web` package while preserving existing overrides and headless defaults.
