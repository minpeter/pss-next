---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Present provider failures without raw diagnostics

The TUI now renders structured runtime failures with a category-owned title,
safe summary, actionable hint, and bounded labeled correlation IDs. It no
longer prints the AI SDK error object or stack and does not classify
provider-specific prose.

`pss exec` exposes the same safe structured `turn-error` metadata in its NDJSON
events and committed result. Legacy events without metadata still render as a
generic failure without speculative guidance.
