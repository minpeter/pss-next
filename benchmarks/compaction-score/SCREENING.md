# Senpi Profile Screening

## 2026-07-24: no winner

Frozen production profile:

- Profile: `production`
- Hash: `sha256:ff99c46efbb488e877c12fefb198c231cd3c8494a76c80a42ee9bd4e626a483e`
- Provider tuple: `current-gateway` / `https://codex.nekos.me` / `gpt-5.6-luna`
- Seed capability: seed omitted after the seeded probe was rejected and the
  seedless probe succeeded.

The fixture originally expected redundant task-state labels despite the
evaluation protocol requiring the shortest exact value. After correcting those
expected values, the full-context control reaches `18/18`.

All 12 production and Senpi rule-bundle profiles were then screened against
that repaired long-session control. Their compacted scores ranged from
`13/18` to `15/18`, below the required 100% recall. The failure is therefore
in compaction retention rather than the evaluator control.

Decision: **no winner**. Promotion and dependent provider campaigns are
blocked until at least one profile retains every long-session fact.

Raw run evidence is retained in
`.omo/evidence/ulw/senpi-pss-compaction-stability-v1/G013-13-screen-senpi-rule-bundles-and-sel/a1/`.
