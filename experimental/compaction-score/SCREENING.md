# Senpi Profile Screening

## 2026-07-25: no winner (code-side follow-up applied)

Clean campaign metadata from the production full-control screen:

- Clean evidence root: `.omo/evidence/ulw/senpi-pss-compaction-stability-v1/G013-13-screen-senpi-rule-bundles-and-sel/a2/production-full-control-20260725T010449Z/`
- Clean revision at screen time: `932779d3d11c3bf439d8107db99829eaaa86a1ea`
- Frozen production profile hash at screen time:
  `sha256:30a56d748f4162fb9a195a5c48c606a91f3bed7d68d0bd4655151e21c4274dad`
- Current production profile hash (after retained Senpi control rules in the
  builder): `sha256:7ea878eb30458a20fb20ed6e41e2987cf91e1f76e2d8fba46c477cd24f86f38c`
- Sanitized provider tuple: `current-gateway` / `https://codex.nekos.me` /
  `gpt-5.6-luna`
- Seedless capability result: the seeded probe was rejected; the seedless probe
  succeeded.

The production full-control run covered 12 scenarios x 3 repetitions. It
exited 1 with 15/36 valid trials. Invalid statuses reported 46 non-compressing
summaries, 20 invalid full controls, and 6 summary-provider failures.

### Profile-independent full-control blockers (code-side fixes)

| Issue | Fix applied after the screen |
|---|---|
| giant-message 4/5 | Expected answer grounded in source (`conversation data`) |
| sparse-fact 2/4 | Labeled exact ID / owner unknown / tool checksum / boundary nonce in source |
| lifecycle 16/17 | Explicit `production domain` / `deployment ID` are `unknown` in the retained tail |

These fixture changes are covered by unit tests. They cannot retroactively
rewrite the archived G013 `a2` trial log.

### Remaining blockers for G014–G019

- A live re-screen on a clean frozen HEAD with a capable provider tuple is
  still required before declaring a winner.
- Non-compressing summaries remain a model/budget interaction (fail-closed is
  correct); they are not resolved by prompt-profile selection alone.
- Several preflight tuples in G013 `a3` failed capability or full-control
  prerequisites; evidence is retained under
  `.omo/evidence/ulw/senpi-pss-compaction-stability-v1/G013-13-screen-senpi-rule-bundles-and-sel/a3/`.

Decision: **no winner yet**. Do not promote a candidate profile. G014–G019
remain blocked pending a successful live production full-control matrix on the
post-fix fixtures.

## 2026-07-25: post-fix live spot rechecks

Focused production rechecks after fixture grounding (not a full 12×3 campaign):

| Scenario | Result | Evidence |
|---|---|---|
| sparse-fact | 1/1 valid, 4/4 retention | session scratch `live-recheck/sparse-fact-2` (also local score output) |
| lifecycle | 1/1 valid (17/17) after one invalid-full-control retry | session scratch `live-recheck/lifecycle` |

Scratch copies under the implementer session dir. Full G013-style 12-scenario
screening was not re-run; G014–G019 remain blocked until a complete matrix
passes with an eligible campaign tuple.
