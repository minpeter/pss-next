---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
  npm:@minpeter/pss-extension-web:
    type: patch
---

## Extract the coding agent's web tools into an extension

Move `web_search`, `web_fetch`, their OpenSearch integration, and TUI renderers
into a default `@minpeter/pss-extension-web` package while preserving existing overrides and headless defaults.
