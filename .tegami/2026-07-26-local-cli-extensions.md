---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Load local extensions without installing

Loose extension modules now load automatically from
`~/.pss/extensions/<name>.<ts|mts|js|mjs>` and
`~/.pss/extensions/<name>/index.*`, plus the project-scoped
`<project>/.pss/extensions/` once the project is trusted. TypeScript modules
run directly through Node's native type stripping, so authoring an extension
needs no packaging or build step. File and directory names become the stable
extension id and must match `[a-z0-9][a-z0-9._-]*`; symbolic links and invalid
names are skipped with startup notices instead of failing startup.

Managed installs keep precedence: a local module whose id collides with an
installed extension is skipped with a notice, and project-local modules
override global-local modules with the same id. Untrusted projects that
contain loose extension modules surface the existing blocked-extensions
notice.

Add a repeatable `-e`/`--extension <path>` flag to the TUI and `pss exec` that
loads a module file or index directory for the current run only, without
touching settings. CLI extensions are an explicit user action, so they load
without trust gating and take precedence over configured extensions with the
same id. Invalid paths, non-module files, duplicate ids, and missing index
modules fail fast with actionable errors before the session starts.
