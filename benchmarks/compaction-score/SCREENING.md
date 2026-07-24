# Senpi Profile Screening

## 2026-07-24: screening pending

Frozen production profile:

- Profile: `production`
- Hash: `sha256:ff99c46efbb488e877c12fefb198c231cd3c8494a76c80a42ee9bd4e626a483e`
- Provider tuple: `current-gateway` / `https://codex.nekos.me` / `gpt-5.6-luna`
- Seed capability: seed omitted after the seeded probe was rejected and the
  seedless probe succeeded.

The fixture originally expected redundant task-state labels despite the
evaluation protocol requiring the shortest exact value. After correcting those
expected values, the full-context control reaches `18/18`.

All 12 production and Senpi rule-bundle profiles were then screened once
against that repaired long-session control. A stricter canonical-answer
instruction made the task-value representation consistent across full and
compacted contexts. Under that contract, `senpi-verbatim-request` retained
`54/54` facts across three long-session repetitions.

Its required full 12-scenario campaign stalled indefinitely in the first
baseline request and was terminated after ten minutes without a result.
Decision: **screening pending**. Promotion and dependent provider campaigns
remain blocked until a complete bounded campaign is available.

Raw run evidence is retained in
`.omo/evidence/ulw/senpi-pss-compaction-stability-v1/G013-13-screen-senpi-rule-bundles-and-sel/a1/`.
