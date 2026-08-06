# Pi compatibility baseline

[`pi-v0.83.0.json`](./pi-v0.83.0.json) is the machine-readable comparison
between PSS and Pi v0.83.0. The release tag is pinned to upstream commit
[`845d6ff1f6643aba440341cce877ce1c43ebbc39`](https://github.com/badlogic/pi-mono/commit/845d6ff1f6643aba440341cce877ce1c43ebbc39),
so a moved tag or a later Pi release cannot silently change the baseline.
Evidence under `upstream` is relative to that commit; evidence under `local` is
relative to this repository.

Every tracked surface has one classification:

- `native`: PSS independently implements the comparable user-facing surface.
- `adapter`: PSS covers the use case through a PSS-owned boundary or dependency,
  rather than promising API identity.
- `planned`: the surface is recorded as a gap. This is inventory, not a delivery
  commitment or schedule.
- `intentional-difference:ai-sdk`: PSS deliberately uses AI SDK model contracts.
- `intentional-difference:durable-execution`: PSS deliberately owns durable
  execution, replay, and recovery boundaries.

Those last two are the complete intentional-difference vocabulary. A new
architectural exception requires an ADR and schema change; it cannot be added as
free-form manifest text.

## Updating the baseline

1. Add a new versioned manifest instead of editing the history of an old Pi
   baseline.
2. Pin the tag to its full 40-character upstream commit and review the upstream
   evidence at that commit.
3. Classify every comparison surface and provide upstream and local evidence.
4. Run `pnpm check:compatibility` and the repository test suite.

The JSON Schema rejects unknown fields and classifications and requires exactly
one surface for each of the two intentional differences. The validator
discovers and checks every `docs/compatibility/pi-v*.json` manifest; there is no
unchecked historical or inactive version. It also rejects duplicate surface IDs
and missing local evidence paths. Evidence must resolve inside the repository,
including after symbolic-link resolution, and each filename must match its
`baseline.release` (`pi-${baseline.release}.json`). CI runs the validator
independently of the general test job.

See [ADR 0001](../adr/0001-pi-compatibility-baseline.md) for the decision and
scope.
