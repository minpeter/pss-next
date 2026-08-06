---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Guard tegami entries with a pending-note heading check

Find and repair pending release entries that had no `##` body section, which
made tegami skip them silently; add `pnpm check:tegami-notes` to the Validate
workflow so a pending entry without a visible section heading fails CI before
it can become unreleasable again.
