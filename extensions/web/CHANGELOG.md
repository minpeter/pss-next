## @minpeter/pss-extension-web@0.0.1-next.1 (next)

### Update the AI SDK

Update runtime and consumer packages to AI SDK 7.0.51 for consistent tool types and downstream version alignment.

## @minpeter/pss-extension-web@0.0.1-next.0 (next)

### Update the AI SDK

Update the runtime, coding agent, and web extension to AI SDK 7.0.45.

### Extract the coding agent's web tools into an extension

Move `web_search`, `web_fetch`, their OpenSearch integration, and TUI renderers
into a default `@minpeter/pss-extension-web` package while preserving existing overrides and headless defaults.
