## @minpeter/pss-extension-mermaid@0.0.1-next.3

### Publish built-in extensions to the latest dist-tag

The extension manager resolves tagless installs through `latest`, so the built-in extensions now publish there instead of `next`; this release also moves `latest` off the stale pre-#335 builds.

## @minpeter/pss-extension-mermaid@0.0.1-next.2 (next)

### Publish built-in extensions as installable packages

First publish of the three built-in extensions with their publishable manifests (no private flag, concrete peer ranges), enabling `pss extension install`/`update` to deliver them between coding-agent releases.

## @minpeter/pss-extension-mermaid@0.0.1-next.1 (next)

### Declare the coding agent dependency in extensions

Add @minpeter/pss-coding-agent as a dev dependency of the LaTeX, Mermaid, and web extensions so Turborepo 2.10.8 boundaries accepts the /extension imports.

### Update the pi-tui renderer dependency

Bump @earendil-works/pi-tui from 0.82.1 to 0.83.0 in the coding agent and the LaTeX and Mermaid extensions.
