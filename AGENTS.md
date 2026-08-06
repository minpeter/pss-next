# Pull Requests

- Before merging a pull request, add a Tegami entry with a concise 1–3 line summary of the change.
- Use a patch-level release unless the pull request or user explicitly specifies a different release level.

# Tegami entries

Entries are `.tegami/YYYY-MM-DD-slug.md` files with frontmatter like:

```yaml
---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---
```

- Target the published package whose behavior changes: `npm:@minpeter/pss-runtime` or `npm:@minpeter/pss-coding-agent`. Changes under `extensions/` target `npm:@minpeter/pss-coding-agent` because the built-in extensions ship inside its bundle.
- Always use `type: patch` (or minor/major when asked). The `replay: exit-prerelease(...)` form is reserved for changes that must not bump a version (docs-only, CI-only); using it for a code change makes the Version Packages PR silently skip the entry.
- Give the entry body at least one `## <Title>` section. Tegami only drafts notes whose body parses into a markdown section, so a pending entry without any heading is silently never released; `pnpm check:tegami-notes` enforces this in CI.
- Copy the form from this template, not from an arbitrary existing entry.

# Releases

- Never merge the automated `Version Packages` pull request on your own. Merging it publishes to npm, so merge it only when the user explicitly asks to release (e.g. "릴리즈하자").
