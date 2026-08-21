---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Bound manual compaction and chain overflow timeout causes

Manual compaction (`thread.compact()`) now runs under the same shared episode
deadline as scheduled and overflow compaction: when the policy omits
`deadlineMs`, the runtime applies `DEFAULT_COMPACTION_DEADLINE_MS` (15s) to the
manual episode instead of letting it hang unbounded.

When overflow recovery compaction exceeds its deadline, the thrown
`CompactionDeadlineExceededError` now carries the original overflow error
(`ContextBudgetExceededError` or the provider's context-window error) as its
`cause`, so callers can inspect what triggered the failed recovery.
