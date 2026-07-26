# Robust compaction-score results

Date: 2026-07-24

## Protocol

- Three deterministic calls per trial: one summary, one batched full-context
  evaluation, one batched compacted-context evaluation.
- Three independent fixture seeds by two repetitions: six valid trials.
- 24 hidden questions per trial, 144 paired observations total.
- Full-context control must be perfect.
- Exact-match scoring with trim/case/whitespace/trailing-period normalization.
- Summary quality and compression are reported separately.

The local coding-agent provider could not execute the matrix because it
returned `User banned`. The runner correctly recorded this as
`summary-provider-failure` and excluded it from quality statistics. To complete
the prompt-quality experiment, the same exported fixtures, production summary
contract, compaction wrapper, shared tail, and batched questions were evaluated
by independent deep-worker model calls.

## First structured-contract run

| Metric | Result |
|---|---:|
| Valid trials | 6/6 |
| Full-context control | 144/144 |
| Compacted retention | 138/144 (95.83%) |
| Wilson 95% CI | 91.21%-98.08% |
| Trial mean / population SD | 95.83% / 3.40% |
| Trial range | 91.67%-100% |
| Mean summary/input ratio | 38.10% |
| Summary-ratio SD | 1.38% |

All six misses were paraphrases of the task blocker or next action. Project
facts, exact identifiers, corrections, tool evidence, and task status were
preserved.

## Verbatim labeled-state iteration

The contract was changed to copy source values labeled `Next action`,
`Blocker`, `in-progress`, `blocked`, or `queued` verbatim and to emit no
preamble.

| Metric | Result |
|---|---:|
| Valid trials | 6/6 |
| Full-context control | 144/144 |
| Compacted retention | 144/144 (100%) |
| Wilson 95% CI | 97.40%-100% |
| Trial mean / population SD | 100% / 0% |
| Trial range | 100%-100% |
| Mean summary/input ratio | 34.09% |
| Summary-ratio SD | 3.33% |
| Summary-ratio range | 28.97%-38.39% |

The targeted change removed all task-continuation misses while reducing the
average summary ratio by four percentage points.

## Threats to validity

- Six trials establish a useful regression baseline, not universal model
  superiority.
- The final matrix used the independent worker model path because the
  configured coding-agent provider was banned.
- Exact synthetic facts cover continuity failure modes but do not replace
  long-running production telemetry.
- Provider/model changes require rerunning the matrix; scores are not portable
  across models.

## Expanded corner-case matrix

The registry was expanded with one baseline, one two-hop lifecycle, and one
boundary-noise fixture, each repeated twice. Summary generation and evaluation
used different worker model roles to reduce producer/evaluator leakage.

| Scenario | Result |
|---|---:|
| Baseline | 48/48 |
| Lifecycle, two hops | 34/34 |
| Boundary noise | 22/22 |
| Aggregate | 104/104 |

The expanded questions found no additional recall miss, but they exposed a
compression failure that recall-only scoring had hidden:

- lifecycle hop 1 summary/input ratio: `1.048-1.215`
- lifecycle final hop ratio: `0.732-0.810`

The first summary could therefore be larger than the source context. Production
compaction now caps output adaptively to half the estimated summary input and
rejects any result that is not smaller than its source. The benchmark records
that rejection as `non-compressing-summary`, separate from provider failures.

Two repeated lifecycle trials after the fix retained `17/17` each while reducing
hop ratios to:

- hop 1: `0.551-0.566`
- hop 2: `0.490-0.540`

## Senpi prompt adaptation experiment

The canonical Senpi `2026.7.23` compaction prompts were compared using the
same expanded fixtures. The configured `gpt-5.6-luna` endpoint rejects the
optional `seed` parameter, so these runs used `--omit-summary-seed`; provider
and full-context-control failures remained invalid attempts rather than misses.

Applying Senpi's full fixed-section contracts directly was not safe for the
runtime's smaller multi-hop boundary:

| Prompt variant | Valid trials | Valid-arm recall | Result |
|---|---:|---:|---|
| Full seven-section Senpi contract | 4/6 | 70/70 | lifecycle hop 1 expanded on all six attempts |
| Four-section turn-prefix contract | 6/6 | 102/104 | compressed well but omitted a blocker and superseded test failure |
| Repeated turn-prefix contract | 6/6 | 74/104 | unstable second-hop durable-state retention |
| Ten-section Senpi-PSS hybrid | 4/6 | 70/70 | lifecycle hop 1 expanded on all six attempts |
| Source-size adaptive hybrid | 6/6 | 101/104 | still lost exact facts and retried two expansions |

The retained implementation therefore keeps PSS's proven nine durable-state
sections and incorporates only the Senpi behaviors that survived the matrix:

- mark the summarization instruction as internal control, never user intent;
- silently extract current task intent before writing;
- preserve the active user request and explicit constraints verbatim.

Final retained run:

| Metric | Result |
|---|---:|
| Valid trials | 6/6 |
| Attempts | 8 (two invalid full-context controls) |
| Baseline | 48/48 |
| Lifecycle, two hops | 34/34 |
| Boundary noise | 22/22 |
| Aggregate | 104/104 |
| Mean summary/input ratio | 45.19% |
| Summary/input range | 20.98%-73.27% |
| Mean savings | 54.81% |

This preserves the previous 104/104 recall result. It does not establish that
the Senpi-derived rules are universally superior: the provider differed from
the earlier cross-model matrix and model seeds were unavailable. It does show
that copying Senpi's complete schema would regress this runtime, while the
three retained control rules preserve the measured behavioral boundary.

## Head-to-head vs pi-coding-agent default compaction

`compare-pi.ts` replicates the pi-coding-agent summarization protocol
verbatim (serialized `<conversation>` text with 2,000-char tool-result
truncation, pi's summarization system/user prompts, `<previous-summary>`
update-merge on later hops, `<read-files>`/`<modified-files>` appendix,
0.8 × 16,384-token output budget) and runs it against the runtime pipeline
on identical fixtures, cut points, evaluator, and scorer.

An earlier run exposed two validity problems that were fixed before the
final matrix:

1. The runtime's unbudgeted tool-evidence ledger made summaries larger
   than tool-dominated sources, so the non-expansion guard rejected
   compaction entirely (3/6 trials). The ledger now takes at most 25% of
   the source, the model summary budget subtracts ledger and wrapper cost,
   and sub-wrapper ranges are skipped.
2. The ledger's salient-line keywords mirrored the fixtures' vocabulary.
   Salience is now template-frequency based: identifiers, hashes, and
   counters are masked, lines cluster by masked template, and only rare
   templates survive. No keyword list remains.

The audit matrix adds three blind hold-out scenarios that share no surface
patterns with the originals (JSON-lines noise, Korean prose noise,
timestamped INFO logs) plus a paraphrase-tolerant LLM-judge secondary
score applied symmetrically to both arms. Hold-outs were scored one-shot:
no implementation changes after observing their results.

| Matrix (exact / semantic) | pss | pi default |
|---|---|---|
| Hold-outs, gpt-5.6-luna | 36/42 / 38/42 | 18/42 / 22/42 |
| Hold-outs, gpt-5.6-terra | 38/42 / 41/42 | 19/42 / 23/42 |
| Overall, gpt-5.6-luna | 139/146 / 142/146 | 101/146 / 111/146 |
| Overall, gpt-5.6-terra | 140/146 / 144/146 | 107/146 / 113/146 |

All 24 trials per model were valid for both arms. Mean summary/input
ratios were stable across models: pss ≈ 0.47, pi ≈ 0.31 (pi compresses
about 2× harder on noisy tool logs, 0.15 vs 0.34 on hold-outs). Every
exact identifier (checksums, undo commands, regions, snapshot tags)
survived the pss ledger on the hold-outs; remaining pss misses were
Korean phrasing variants of semantically correct answers.

Interpretation limits: two sibling models from one provider, n=12 valid
trials per arm per model, provider rejects seeds, and pi's live
mitigations (20k-token keep-recent window, re-deriving lost values via
tools) are out of scope for a summarizer-quality benchmark.
