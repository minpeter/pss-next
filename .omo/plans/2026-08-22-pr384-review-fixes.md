# PR #384 review fixes

Worktree only: `/tmp/pss-bound-compaction-pr`. Never edit the dirty `main`
checkout.

## Runtime invariants

1. Use one absolute deadline for hydration, policy work, summaries, retries,
   transforms, hooks, freshness checks, and waiting to reach the durable write.
2. Keep `DEFAULT_COMPACTION_DEADLINE_MS = 15_000`; do not split the budget.
3. Once the serialized store mutation begins, await its atomic commit or
   rollback beyond the deadline.
4. Blocking overflow and manual requests outrank pending completed-turn work,
   while queued completed-turn callers share a completion promise.
5. Reuse prepared candidates only for a proven standard provider projection
   whose hydrated wrapper and tail fit the budget.
6. An aborted episode cannot install, replace, consume, or evict a candidate.
7. Errors and diagnostics retain only bounded, sanitized metadata.

## Review components

1. Deadline ownership and durable commit boundary
2. Single-flight scheduling, pending promises, and caller cancellation
3. Candidate provenance, hydration, expansion, and abort safety
4. Manual deadline inheritance and automatic invalid-deadline fallback
5. Privacy-safe timeout causes and lifecycle diagnostics
6. Runtime module extraction under the 250 pure-LOC ceiling
7. Public API snapshot and package type exports
8. Compaction benchmark correctness, causal ordering, and TTFV measurement
9. Tegami consolidation and removal of absent calibration commands
10. Full lint, tests, typechecks, build, API, audit, and real CLI verification

## Exclusions

- Do not add the untracked five-track, deadline-sweep, task-utility,
  production-overlap, or human-calibration campaign files.
- Do not merge PR #382. After #382 lands, rebase #384, deduplicate its nanoid
  override, and preserve #382's summary-instruction isolation.
- Do not merge the automated Version Packages pull request without an explicit
  release request.
