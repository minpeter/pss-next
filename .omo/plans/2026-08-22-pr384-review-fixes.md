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
6. Runtime module extraction near the approximately 250 pure-LOC review target
7. Public API snapshot and package type exports
8. Compaction benchmark correctness, causal ordering, and TTFV measurement
9. Tegami consolidation and removal of absent calibration commands
10. Full lint, tests, typechecks, build, API, audit, and real CLI verification

## Final review blocker corrections

1. Check both the episode signal and absolute wall clock after serialized
   snapshot encoding and immediately before the store call. Handlers receive a
   commit capability rather than an early boundary marker.
2. Keep prepared candidates only when preparation provenance is standard.
   Abort after initial installation, replacement, or selection restores the
   prior slot, and promotion returns a detached input without eager eviction.
3. On optimistic conflict, install authoritative remote state plus only a
   structurally proven local suffix appended after the attempted snapshot.
   Remote deletion or prefix divergence preserves no suffix.
4. Keep compaction-record identity private behind an idempotent rollback
   closure; the public history method returns no mutable stored alias.
5. Fall back to measured instructions when a token meter has no active fixed
   prompt, while preserving calibrated fixed-prompt accounting.
6. Combine a summary-specific cancellation signal with the episode signal,
   validate raw correlation-source length before bounding, and render arbitrary
   backtick runs without argument spreading.
7. Track concurrent deterministic summary service on a summary-only offset so
   overlap remains visible without becoming artificial user block.
8. Reconcile conflict history only when attempted, remote, and current-local
   histories are linearly comparable. Divergent or deleted remote state
   preserves no local suffix, and extended remote state is never duplicated.
9. Track speculative candidate liveness independently from slot ownership so a
   replacement rollback skips every predecessor whose own episode aborted.
10. Detach the pending completed-turn cohort at active retry start. Use its
    latest request options under the original deadline, settle it on a resolved
    retry, restore it after a failed retry, and leave later schedules pending.
11. Recheck prepared-summary freshness inside the serialized state write after
    every queued predecessor settles and before recording the compaction.
12. Process valid comparison artifacts with bounded iteration and reduction;
    one row with many hops and many timed rows must not overflow argument lists.
13. Apply the PSS comparison character cap to the final assembled summary,
    including deterministic evidence, before expansion validation and scoring.
14. Bind prepared candidates to both persisted and hydrated source prefixes;
    stale installations are compare-and-set slots, never abort predecessors.
15. Reject control-bearing or overlong comparison labels at the artifact
    boundary, escape table cells, and append arbitrary failure rows iteratively.
16. Classify compaction wrappers and test prompts through machine structure,
    never natural-language sentences or explanatory documentation.
17. Keep runtime production modules near 250 pure LOC by isolating scheduling,
    persistence, and conflict reconciliation from their public facades.
18. Classify benchmark summary calls by prompt roles, not instruction prose,
    and keep all dynamic CLI labels terminal-safe.
19. Parse comparison numeric fields into safe semantic ranges and reject any
    artifact whose accumulation or derived metrics exceed finite safe bounds.
20. Admit correlation headers only when raw lowercase terminal-safe names are
    unchanged, and bound error traversal with an iterative visited worklist.
21. Give both comparison arms the same provider/final summary budget and retain
    only stable failure classes, never raw provider errors.
22. Keep every changed runtime production module under the pure-LOC ceiling by
    extracting AgentThread orchestration and provider metadata parsing.

## Exclusions

- Do not add the untracked five-track, deadline-sweep, task-utility,
  production-overlap, or human-calibration campaign files.
- Do not merge PR #382. After #382 lands, rebase #384, deduplicate its nanoid
  override, and preserve #382's summary-instruction isolation.
- Do not merge the automated Version Packages pull request without an explicit
  release request.
