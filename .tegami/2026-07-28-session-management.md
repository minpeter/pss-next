---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Manage named, resumable, forkable sessions with lifecycle events

The TUI now manages sessions per working directory. Metadata — display
names, fork parentage, and the active session resumed on the next startup —
lives in a fail-safe sidecar index next to the thread files; a corrupt
index degrades to an empty one with a notice and never touches durable
thread state. Session recency bumps on every completed turn, so pickers
sort by actual use. `PSS_THREAD_KEY` still forces a key; the forced key is
registered (naming and forking work) but never clobbers the active pointer
for regular startups, and `pss inspect-thread` follows the active session
unless the key is forced.

Commands: `/new [name]` starts a new empty session. `/resume` opens an
interactive picker to switch, rename, or delete a session (deleting the
live session is blocked); `/resume <key|name>` switches directly with
argument completions. `/name <name>` and the `--name` startup flag set the
display name shown in the header. `/fork` offers branch points: the latest
state or before any earlier user message — the fork keeps the truncated
history, drops compaction records that extend past the cut, seeds
`appliedMigrations` so migrations never re-run, and records the parent
thread key; a fork whose registration fails deletes its copied thread.
`/clear` keeps its wipe-in-place meaning and loses its `new` alias to the
dedicated command. `new`, `resume`, `name`, `fork`, and `model` join the
reserved command names.

Extensions observe the lifecycle through host bus events:
`host:session-start` (reasons `startup`/`new`/`resume`/`fork`/`clear`),
`host:session-switch`, and `host:session-shutdown`. The new `sessionGuard`
capability adds cancelable pre-switch/pre-fork decision points; guard
errors, timeouts, malformed decisions, and explicit `null` returns fail
closed, consistent with strict hook decisions.

`@minpeter/pss-runtime` exports the thread snapshot codecs
(`decodeStoredThreadState`, `encodeThreadSnapshot`, and their types and
validation errors) so hosts can implement branch-before-message forks over
validated state instead of parsing stored snapshots by hand.
