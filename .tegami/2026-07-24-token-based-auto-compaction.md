---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Token-based auto-compaction and non-compressing summary guard

Auto-compaction thresholds move from message counts to token budgets
(`maxInputTokens` / retain targets). Summaries that would grow the context
instead of shrinking it are rejected so recall-only benchmarks cannot hide
negative compression.

The coding-agent thread config/inspect paths and worker-agent integration
follow the same token-based policy. The expanded compaction-score benchmark
covers lifecycle and boundary cases that the previous suite missed.
