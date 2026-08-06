# Contributing

## QA discipline

`pnpm test`, `pnpm typecheck`, and `pnpm build` being green is not QA. They prove
the unit-level contract holds, not that the user-facing behavior works. Drive the
real surface and record what you observed.

The core published packages have a regression coverage gate. Run
`pnpm coverage` to test `packages/runtime/src` and `apps/coding-agent/src`, print
a terminal report, enforce the baseline, and write machine-readable results to
`coverage/core/coverage-summary.json`. Test files and explicit test-support or
fixture modules are excluded; examples, extensions, and experimental workspaces
remain outside this focused gate.

Scope the QA to what you touched:

| Change area | Required real-surface QA |
| --- | --- |
| `apps/coding-agent/src/tui/**` | Render the TUI through the xterm.js harness: `node script/qa/web-terminal-visual-qa.mjs --title "<surface>" --command "<cmd>" --input "<keys>" --evidence-dir <dir>` |
| `apps/coding-agent/src/cli.ts`, `exec-cli.ts` | Run the built CLI (`node apps/coding-agent/bin/pss.js ...`) and capture stdout plus the exit status |
| `apps/coding-agent/src/workspace-tools/**` | Exercise the tool through a real agent turn, not just its unit test |
| `packages/runtime/**` | Scoped tests plus one execution of an affected runnable entry point |

Never use `tmux capture-pane` for terminal color, layout, or CJK evidence: it
degrades truecolor and wide-glyph width. Use the xterm.js harness instead.

## Evidence: record it under `.omo/evidence/` or it did not happen

Write every QA artifact to `.omo/evidence/<YYYYMMDD>-<short-slug>/`, one folder
per change. For every change record:

- **What was observed** — the before/after or new behavior, plus the artifact
  path for the exact captured output.
- **Why it is enough** — how the evidence covers the intended behavior and what
  regression risk remains.

**No evidence means no commit and no push.**

Evidence is a local artifact. `.omo/` is ignored except `.omo/plans/`, so
receipts stay on your machine while the PR body carries the verification
summary. Do not commit evidence directories, screenshots, or session state.

Evidence, logs, commit messages, and PR bodies must not contain tokens,
credentials, auth headers, cookies, or raw environment dumps.

## Failing-first proof

Every behavior change needs a proof that failed before the production change,
through the cheapest faithful channel: a unit test where a seam exists, an
integration test where the behavior lives in wiring, or the real-surface
scenario captured failing when no seam exists.

A test that cannot fail for the regression it names is not evidence. Mock-call
assertions, pinned constants, and expected values re-derived from the output
under test all pass regardless of the bug. Prefer a real-surface proof with no
new test over a tautological one.

For regression coverage of already-correct behavior there is no natural RED.
Substitute a mutation proof: temporarily break the seam, capture the assertion
failing, then revert the mutation. Never commit the mutation.

## Cleanup

QA spawns processes, browsers, ports, and temp directories. Tear down everything
you started and verify it: `kill` the pid and confirm `kill -0` fails, close
browser contexts, remove the `mktemp` paths. Leftover QA state means the change
is not done.

## Commits and PRs

- One atomic commit per verified increment; each commit builds and tests green on
  its own. No WIP commits on a branch you intend to merge.
- Read `git log --oneline -20` before writing a message and match the observed
  convention. Default to Conventional Commits (`<type>(<scope>): <imperative>`).
- Push to a feature branch and open a PR. Never push directly to `main`.
- The PR body states what changed, how it was verified, and any deliberate
  trade-off a reviewer would otherwise question.

## Never

- Suppress lint errors, type errors, or test failures.
- Delete, skip, `.only`, `.skip`, or comment out a failing test to go green.
- Claim done from inference. Only captured evidence counts.
