# Runtime TypeScript strictness migration

The runtime runs two complementary checks:

- `tsconfig.json` checks the complete source tree, including tests and reusable
  contract suites, with the repository strict baseline.
- `tsconfig.production.json` checks shipped runtime source with
  `noUncheckedIndexedAccess`. It excludes `**/*.test.ts` and `src/contracts/**`
  because those files are test-only and are not part of a `tsdown` entry graph.

Both checks are part of `pnpm --filter @minpeter/pss-runtime typecheck`. Indexed
access fixes must narrow or validate possibly missing values; do not use
non-null assertions or type assertions to silence diagnostics.

`tsconfig.exact-optional.json` additionally enforces
`exactOptionalPropertyTypes` for migrated production subsystems. It currently
covers the `src/otel` entry graph, including its shared LLM and turn-protocol
dependencies; every migrated leaf must remain in this committed check as the
scope expands.

## Suppression inventory

As of 2026-08-13, production runtime source has **zero TypeScript diagnostic
suppressions** (`@ts-ignore`, `@ts-expect-error`, or `@ts-nocheck`) for either
strictness option. This migration adds none. The production configuration has
only these test-source exclusions:

| Exclusion | Current files | Reason |
| --- | ---: | --- |
| `src/**/*.test.ts` | 141 | Vitest suites; retained in the complete-tree check |
| `src/contracts/**/*.ts` | 12 | Reusable Vitest contract suites imported only by tests |

Biome suppressions are unrelated to TypeScript strictness and remain
individually documented at their call sites. New TypeScript diagnostic
suppressions are not an accepted migration mechanism.

## `exactOptionalPropertyTypes` baseline

Run the next-stage check with:

```sh
pnpm --filter @minpeter/pss-runtime exec tsc \
  -p tsconfig.production.json --noEmit --exactOptionalPropertyTypes
```

After migrating the `otel` entry graph, the 2026-08-13 baseline is **157
diagnostics in 75 files**:

| Diagnostic | Count | Main meaning |
| --- | ---: | --- |
| TS2379 | 111 | An explicit `undefined` is passed to an optional property |
| TS2375 | 26 | An object literal materializes an optional property as `undefined` |
| TS2322 | 10 | Assignment does not distinguish absent from `undefined` |
| TS2412 | 7 | Optional class/object property is assigned `undefined` |
| TS1360 | 1 | `satisfies` exposes an optionality mismatch |
| TS2420 | 1 | Implementation and interface optionality differ |
| TS2430 | 1 | Interface extension optionality differs |

Subsystem distribution: thread 59, platform 58, agent 13, evals 12, llm 7,
execution 6, testing 2, and otel 0. Refresh this inventory in the same PR that
changes the baseline. `otel` is guarded at zero by
`tsconfig.exact-optional.json`.

## Staged plan

1. **Define contracts first.** Audit exported optional properties and decide
   whether omission has meaning distinct from an explicit `undefined`. Change
   public types only when `undefined` is intentionally accepted; otherwise
   omit keys at construction sites.
2. **Migrate leaf subsystems.** Enable focused temporary checks for `otel`,
   `execution`, `evals`, and `testing`, then move through `llm` and `agent`.
   Each slice must keep its diagnostic count at zero without suppressions.
3. **Migrate storage and thread state.** Handle `platform` and `thread` together
   where persisted records cross the boundary. Add round-trip tests before any
   representation change so absent keys and explicit `undefined` cannot drift.
4. **Enable globally.** Add `exactOptionalPropertyTypes` to
   `tsconfig.production.json`, then migrate the test-only configuration and
   remove the exclusions only after the full source tree is clean.
