# compaction-score

Behavioral quality benchmark for runtime automatic compaction, modeled on the
`pi-openai-server-compaction` native-vs-text protocol.

## Experimental unit

One valid trial uses one summary call per compaction hop plus two evaluation
calls:

1. Generate each production compaction summary with `temperature: 0`, a
   deterministic hop seed when supported by the provider, and an adaptive hard
   output-token cap.
2. Answer every hidden question in one JSON response against full context.
3. Answer the same questions in one JSON response against final compacted
   context.

Question batching removes the 48 independent QA calls that previously
dominated variance. Full and compacted arm order rotates by repetition.

## Fixtures and questions

The default registry rotates three complementary scenarios:

- **baseline**: 92 messages and 24 exact, correction, tool-history, and
  task-continuation questions.
- **lifecycle**: two chained compactions covering corrected runtime targets,
  file rename/deletion, feature cancellation, failed approaches, failed then
  passing tests, blockers, next actions, and explicit unknowns.
- **boundary-noise**: more than 5,000 estimated prefix tokens with 270 noisy
  tool-log lines, tool-only exact facts, a failed first inspection,
  case-sensitive symbol correction, and a fact immediately before compaction.

The default matrix is three independent fixtures by two repetitions: six valid
trials. A failed provider call, malformed JSON response, non-compressing
summary, or imperfect full-context control invalidates the attempt; it never
counts as a compaction miss. Each matrix cell retries up to three attempts.

## Scoring and reports

- The headline is compacted-arm exact-match retention.
- Full context must score 100%; otherwise the attempt is invalid.
- Normalization covers trim, case, whitespace, and trailing periods.
- `summary.json` reports:
  - aggregate retention and per-category retention,
  - per-scenario retention and per-hop compression,
  - trial mean, population standard deviation, minimum, and maximum,
  - aggregate Wilson 95% confidence intervals,
  - summary/input compression and savings distributions,
  - invalid attempt counts by failure class.
- `trials.jsonl` persists every valid and invalid attempt.
- `manifest.json` records model, seed, budgets, and protocol.
- `fixtures.json` freezes the generated sessions.

## Run

```sh
pnpm install
pnpm --filter @minpeter/pss-benchmark-compaction-score score
```

Options:

```text
--fixtures N
--trials N
--max-attempts N
--seed STRING
--omit-summary-seed
--provider-timeout-ms N
--summary-max-output-tokens N
--output PATH
```

Example smoke run:

```sh
pnpm --filter @minpeter/pss-benchmark-compaction-score score -- \
  --fixtures 1 --trials 1 --max-attempts 1
```

Use `--omit-summary-seed` only when an otherwise compatible provider rejects
the optional seed parameter. The manifest records whether model seeds were used.

Provider calls are bounded to 120,000 ms by default, including capability
preflight, summary generation, and both evaluation arms. Override the per-call
limit with `--provider-timeout-ms`; the manifest records the selected timeout.
Timed-out trial calls use the existing summary/evaluation provider-failure
classifications and remain eligible for normal attempt retries.

The default output directory is
`/tmp/compaction-score-<ISO timestamp>/`.

## Head-to-head comparison

Run the same fixture matrix, cut points, evaluator, and model against PSS and
the pi-coding-agent summary protocol:

```sh
pnpm --dir experimental/compaction-score exec tsx \
  --conditions=@minpeter/pss-source compare-pi.ts /tmp/compaction-vs-pi
pnpm --dir experimental/compaction-score table -- \
  /tmp/compaction-vs-pi/comparison.json
```

The generated table reports exact and semantic retention, invalid attempts,
summary ratio and savings, total source/summary/removed token estimates,
retained facts per 1,000 summary tokens, and per-hop compaction latency
including total direct critical-path time, mean, p50, p95, maximum, and
summarizer-input throughput.

The matched-quality sweep enforces each declared output budget locally at four
characters per estimated token. The cap is applied to the final assembled
summary, including deterministic PSS tool evidence and pi file-operation state,
before the runtime non-expansion check and before either arm is scored. Provider
token-limit parameters are still sent, but are not trusted as the fairness
boundary.

Token counts use the runtime's deterministic message-token estimator so both
methods are measured consistently; they are not provider billing usage.
Synchronous block time measures the awaited compaction critical path in this
runner. A coding agent that overlaps speculative compaction with other work can
have a lower user-visible delay, which requires a separate runtime gate
benchmark rather than subtracting an assumed overlap here.

## Interpretation

Compare distributions, not a single best run. The earlier one-call-per-question
protocol produced compacted scores from 2/24 to 23/24 on the same fixture and
model because summary variance, 48 QA calls, and provider saturation were mixed
into one number. The current protocol isolates those sources and treats
provider/protocol/control failures as invalid attempts.

See [`RESULTS.md`](./RESULTS.md) for the six-trial baseline and the
evidence-driven prompt iteration.

## Runtime speculative block time

The quality comparator calls compaction directly, so its latency is summary
service time rather than user-visible runtime blocking. The runtime block-time
benchmark exercises the real `createAgent` path and measures:

```text
treatment TTFV = speculative target send -> first visible assistant output
matched control TTFV = fresh compaction-disabled target send -> first visible output
user delta = treatment TTFV - matched control TTFV
user block = max(0, user delta)
dispatch block = max(0, treatment send-to-provider - matched control send-to-provider)
block avoidance = max(0, summary service - user block) / summary service
```

Six controlled scenarios use the same model and compaction policy:

- `overlap-nonblocking`: a background summary is in flight while the next
  request uses the original context without waiting.
- `prepared-hit`: the candidate finishes before the measured target, which
  automatically promotes it before provider dispatch and uses compacted context.
- `candidate-fit-late-hit`: the target widens the desired range, but the
  prepared candidate plus its full tail still fits and avoids a second summary.
- `candidate-fit-hard-block`: the target waits for an in-flight prepared
  summary and applies the still-fitting candidate, providing a hard-block
  control without inventing a broader fallback.
- `summary-failure-retry-hit`: one failed background summary is retried before
  the target, which promotes the recovered candidate without blocking.
- `repeated-failure-overflow-recovery`: two background failures exhaust the
  retry budget, then the overflow path performs a fresh blocking recovery.

The report decomposes the signed user delta into pre-step queue/commit delta
and post-step context-gate delta before clipping only the final user block.
Benchmark messages contain real payload proportional to their exact synthetic
units, so provider-written summaries cannot alter the 65% prepare, 80%
promote, or overflow boundaries and runtime summary-size validation remains
representative.
Live mode uses real provider summary calls and runtime concurrency;
deterministic mode uses a mock provider and logical clock to validate the
measurement channel. Failed turns, failed summaries, wrong summary-call
counts, and wrong overlap paths invalidate the benchmark. User block of at most
10 ms counts as zero-block. Production `speculativeCompaction` and a bare
policy without `deadlineMs` share `DEFAULT_COMPACTION_DEADLINE_MS` (15s).

```bash
pnpm --dir experimental/compaction-score block-time -- \
  --mode deterministic --repetitions 3 --output /tmp/block-time-deterministic

pnpm --dir experimental/compaction-score block-time -- \
  --mode live --repetitions 3 --output /tmp/block-time-live
```

## Auditable evidence campaigns

The focused runners below turn live or deterministic observations into
validated, hash-addressed artifacts. Live runners use the configured provider
and can consume quota; run deterministic mode and the package tests before a
live campaign.

| Script | Purpose | Primary artifact |
| --- | --- | --- |
| `deadline-outcome` | Exercise every runtime path at one explicit deadline | `runtime-deadline-outcome.json` plus command receipt |
| `deadline-sweep` | Compare validated 5s/10s/15s/20s outcome arms | `deadline-sweep.json` and Markdown report |
| `production-overlap` | Measure paired treatment/control user-block evidence | `production-overlap.json` plus receipt |
| `quality-sweep` | Compare compaction quality across output budgets | `quality-sweep.json` plus receipt |
| `task-utility` | Score downstream task outcomes against exported evidence | `task-utility.json` plus receipt |
| `human-calibration` | Export blinded review packets and score human labels | calibration CSV/JSON artifacts |
| `five-track-report` | Join quality, utility, human, overlap, and deadline evidence | one provenance-checked five-track report |

Every live input consumed by a validator carries its source path, SHA-256, and
command receipt. Validators reject stale hashes, incomplete matrices, duplicate
scenario/repetition cells, non-finite metrics, and mismatched model or mode
metadata. Generated artifacts belong outside the repository (normally under
`/tmp` or `/var/tmp`).

Example deterministic and live deadline arms:

```bash
pnpm --dir experimental/compaction-score deadline-outcome -- \
  --mode deterministic --deadline-ms 15000 --repetitions 10 \
  --output /tmp/deadline-deterministic-15

pnpm --dir experimental/compaction-score deadline-outcome -- \
  --mode live --deadline-ms 15000 --repetitions 10 \
  --output /var/tmp/deadline-live-15

pnpm --dir experimental/compaction-score deadline-outcome-validate -- \
  --input /var/tmp/deadline-live-15/runtime-deadline-outcome.json
```

Use `deadline-sweep`, `production-overlap-validate`,
`quality-sweep-validate`, and `task-utility-validate` only with completed
receipts from their corresponding runners. `five-track-report` additionally
requires a completed human-calibration artifact; it will not silently combine
partial or mixed-model evidence.

Task-utility validation executes candidate workspace code inside Linux
Bubblewrap with an isolated network namespace and Node filesystem permissions.
The default executable is `/usr/bin/bwrap`; set
`PSS_TASK_VALIDATOR_SANDBOX` to another absolute Bubblewrap path when needed.
Validation fails closed when the sandbox is unavailable.
