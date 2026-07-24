# Senpi Profile Screening

## 2026-07-24: no winner

Frozen production profile:

- Profile: `production`
- Hash: `sha256:ff99c46efbb488e877c12fefb198c231cd3c8494a76c80a42ee9bd4e626a483e`
- Provider tuple: `current-gateway` / `https://codex.nekos.me` / `gpt-5.6-luna`
- Seed capability: seed omitted after the seeded probe was rejected and the
  seedless probe succeeded.

The required campaign failed at `long-session` full-context control, where
all nine permitted attempts ranged from `13/18` to `16/18`. The evaluator
therefore could not establish the required 100% control before a
compaction-profile comparison. Because full-context evaluation is independent
of the compaction prompt, no Senpi profile can pass this campaign on this
provider.

Decision: **no winner**. Promotion and dependent provider campaigns are
blocked until a provider can satisfy the frozen full-context control.

Raw run evidence is retained in
`.omo/evidence/ulw/senpi-pss-compaction-stability-v1/G013-13-screen-senpi-rule-bundles-and-sel/a1/`.
