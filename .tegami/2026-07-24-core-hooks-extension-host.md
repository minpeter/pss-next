---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Add the core hooks runtime and installable coding-agent extensions

Replace the legacy runtime plugin pipeline with one typed `AgentHooks`
boundary for model transforms and tool interception. Stored thread snapshots
can now run versioned, atomic migrations that persist exactly-once application
metadata without exposing partial state after callback or commit failures.

Coding-agent extensions can be authored as default-export factories receiving
`ExtensionAPI`, while static programmatic extensions remain supported. The
host composes instructions, tools, commands, UI contributions, lifecycle
callbacks, runtime hooks, and durable thread migrations with source-attributed
validation errors. Concise `pss.use()`, `pss.on()`, and `pss.provide()` methods
register control hooks, named event observers, and branded capabilities for
instructions, tools, commands, migrations, and renderers without restoring
the legacy plugin runtime. Factory capabilities validate and publish
atomically after configuration succeeds.

Add `pss extension install`, `list`, `remove`, `update`, `enable`, and
`disable` for npm, Git, local package, and loose ESM sources at global or
project scope. Trusted project discovery loads extensions consistently in the
TUI and headless exec runner. Managed installs validate package boundaries,
reject symlink and export-path escapes, disable lifecycle scripts, and restore
the prior package and settings state when installation, update, or trust
recording fails.
