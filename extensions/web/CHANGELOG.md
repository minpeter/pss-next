## @minpeter/pss-extension-web@0.0.1-next.4

### Publish built-in extensions to the latest dist-tag

The extension manager resolves tagless installs through `latest`, so the built-in extensions now publish there instead of `next`; this release also moves `latest` off the stale pre-#335 builds.

## @minpeter/pss-extension-web@0.0.1-next.3 (next)

### Publish built-in extensions as installable packages

First publish of the three built-in extensions with their publishable manifests (no private flag, concrete peer ranges), enabling `pss extension install`/`update` to deliver them between coding-agent releases.

## @minpeter/pss-extension-web@0.0.1-next.2 (next)

### Declare the coding agent dependency in extensions

Add @minpeter/pss-coding-agent as a dev dependency of the LaTeX, Mermaid, and web extensions so Turborepo 2.10.8 boundaries accepts the /extension imports.

## @minpeter/pss-extension-web@0.0.1-next.1 (next)

### Update the AI SDK

Update runtime and consumer packages to AI SDK 7.0.51 for consistent tool types and downstream version alignment.

## @minpeter/pss-extension-web@0.0.1-next.0 (next)

### Update the AI SDK

Update the runtime, coding agent, and web extension to AI SDK 7.0.45.

### Extract the coding agent's web tools into an extension

Move `web_search`, `web_fetch`, their OpenSearch integration, and TUI renderers
into a default `@minpeter/pss-extension-web` package while preserving existing overrides and headless defaults.
