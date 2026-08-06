# ADR 0001: Pin and gate the Pi compatibility baseline

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owners:** PSS maintainers

## Context

PSS and Pi solve overlapping coding-agent problems, but a prose claim of
"Pi compatibility" is ambiguous and drifts as either project changes. Pi tags
alone are not immutable enough for an auditable comparison, and unstructured
gap lists cannot prevent a new architectural exception from being presented as
ordinary compatibility work.

## Decision

We record compatibility in a versioned JSON manifest validated by
[`pi-manifest.schema.json`](../compatibility/pi-manifest.schema.json). The first
baseline is Pi v0.83.0 at commit
`845d6ff1f6643aba440341cce877ce1c43ebbc39`.

Each comparison surface is `native`, `adapter`, or `planned`, except for exactly
two deliberate architectural differences:

1. **AI SDK:** PSS accepts AI SDK language-model contracts instead of adopting
   Pi's provider and model execution stack.
2. **Durable execution:** PSS owns durable thread state, replay, suspension, and
   recovery semantics instead of matching Pi's process-local session loop.

`adapter` describes compatibility of intent through a boundary; it does not
claim source, wire, extension, or storage-format identity. `planned` records a
gap without committing to a date. Evidence paths make each classification
reviewable against the pinned repositories.

CI validates the schema, the exact difference vocabulary and cardinality,
unique surface IDs, and existence of local evidence. Updating an existing
classification is therefore an explicit reviewed diff.

## Consequences

- Compatibility claims become diffable and consumable by tooling.
- Pi upgrades require a new pinned baseline and a fresh evidence review.
- A third intentional architectural difference requires changing this ADR and
  schema, rather than adding an unchecked label.
- The manifest is an inventory and decision record, not a claim that PSS is a
  drop-in replacement for Pi.
