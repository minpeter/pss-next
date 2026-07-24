# compaction-score

Behavioral quality benchmark for runtime automatic compaction, modeled on the
`pi-openai-server-compaction` native-vs-text protocol.

## Experimental unit

One valid trial uses one summary call per compaction hop plus two evaluation
calls:

1. Generate each production compaction summary with `temperature: 0`, a
   deterministic hop seed, and an adaptive hard output-token cap.
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
--provider-timeout-ms N
--summary-max-output-tokens N
--output PATH
```

Example smoke run:

```sh
pnpm --filter @minpeter/pss-benchmark-compaction-score score -- \
  --fixtures 1 --trials 1 --max-attempts 1
```

Provider calls are bounded to 120,000 ms by default, including capability
preflight, summary generation, and both evaluation arms. Override the per-call
limit with `--provider-timeout-ms`; the manifest records the selected timeout.
Timed-out trial calls use the existing summary/evaluation provider-failure
classifications and remain eligible for normal attempt retries.

The default output directory is
`/tmp/compaction-score-<ISO timestamp>/`.

## Interpretation

Compare distributions, not a single best run. The earlier one-call-per-question
protocol produced compacted scores from 2/24 to 23/24 on the same fixture and
model because summary variance, 48 QA calls, and provider saturation were mixed
into one number. The current protocol isolates those sources and treats
provider/protocol/control failures as invalid attempts.

See [`RESULTS.md`](./RESULTS.md) for the six-trial baseline and the
evidence-driven prompt iteration.
