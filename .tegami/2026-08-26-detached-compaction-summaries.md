---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Detached compaction summaries outlive episode deadlines

A compaction episode deadline now bounds only the caller's wait, not the
provider work: an in-flight summary continues detached after
`CompactionDeadlineExceededError`, installs as a fail-closed validated
speculative candidate, and the next episode joins or promotes it without a
second summary call. Detached calls are single-flight per thread, honour
explicit summary signals, and carry a fixed 120s leak backstop
(`DETACHED_SUMMARY_BACKSTOP_MS`). Slow models converge across episodes
instead of restarting aborted summaries every episode.
