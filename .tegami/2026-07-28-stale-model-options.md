---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
  npm:@minpeter/pss-runtime:
    type: patch
---

## Tighten model options and remove stale internal code

Model-catalog cache configuration is now exposed only by coding-model session
factories, where it is actually used. The native language-model factories no
longer advertise and silently forward a no-op `catalogCache` option, while the
new session-specific option types preserve explicit cache configuration for
embedders and tests. Shared provider construction also keeps native and
switchable model setup from drifting apart.

Remove an unused copied TUI color palette, three orphaned image-codec
initialization promises, a dead test fixture, and a mismatched image-codec
comment. Repository TypeScript checks now reject unused locals and parameters,
and workspace/Biome metadata is kept aligned with the active pnpm workspace and
tool versions.
