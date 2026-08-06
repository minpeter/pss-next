# RFC: Coding-agent session lifecycle

Status: implemented (initial cut) — tracks issue #258.

## Motivation

The coding agent originally pinned one durable thread per working directory
(`cwd:<path>`), with a destructive `/clear` operation that deleted and
recreated the same key. Multiple parallel sessions, resuming older work,
naming, and branching all require explicit session management, and
extensions need lifecycle visibility so their state does not silently
outlive the thread it belongs to.

## Concepts

- **Session** — a durable thread plus sidecar metadata. The runtime's
  `ThreadStore` persists opaque state only; metadata lives in
  `<thread-dir>/sessions.json` (the *session index*):
  `key`, `cwd`, optional `name`, optional `parentKey` (fork parentage),
  `createdAt`, `updatedAt`, and a per-cwd `active` pointer that decides what
  the next startup resumes.
- **Lifecycle reason** — why a session became active:
  `startup` | `new` | `resume` | `fork` | `clear`.

The index fails safe: a missing or malformed file degrades to an empty
index (with a startup notice) and never blocks the session or touches
durable thread state. Writes are atomic (temp + rename) and serialized
within a process; across processes the index is last-writer-wins metadata
only — concurrent TUIs can overwrite each other's name/active updates, but
durable thread state stays consistent because the thread files themselves
are lock-protected by the runtime store. `PSS_THREAD_KEY` still forces an
explicit key and bypasses the active pointer (the forced key is still
registered so naming and forking work).

## Phase 1 — runtime lifecycle events

Host-published bus events (extensions subscribe via `services.events.on`;
the `host:` namespace stays publish-reserved):

| Event | Payload | When |
| --- | --- | --- |
| `host:session-start` | `{ key, name?, reason }` | a session became active (emitted after extension activation for `startup`) |
| `host:session-switch` | `{ fromKey, toKey, reason }` | the active thread handle was replaced |
| `host:session-shutdown` | `{ key }` | the interactive session is ending |

### Cancelable decision points

Pre-switch and pre-fork decisions use **session guards**, a capability
(`sessionGuard({ beforeSwitch?, beforeFork? })`), not bus events, so the
decision model stays strict and synchronous-in-order like `AgentHooks`:

- guards run sequentially; the first cancellation wins;
- a guard returns `undefined` / `{ cancel?: false }` to allow or
  `{ cancel: true, reason? }` to cancel;
- malformed decisions, thrown errors, and host-timeout expiries **fail
  closed** (the change is cancelled) and are attributed to the owning
  extension;
- `beforeFork` receives `{ fromKey, reason: "fork" }`; `beforeSwitch`
  receives `{ fromKey, toKey?, reason }`. `toKey` is present for `resume`
  (the target session exists) and absent when the target has not been
  created yet (`new`, and forks by definition).

### Replacement semantics (what a switch invalidates)

To avoid pi's documented "session replacement footguns", the swap is
narrow and explicit:

- the extension host, agent, tools, hooks, and per-extension JSON state are
  **host-scoped, not thread-scoped**: they survive a switch unchanged;
- only the TUI's thread handle is replaced (`interrupt → dispose → rebind`);
  in-flight turns of the previous session are interrupted before disposal;
- an extension that caches the thread key (or per-thread data) must resubscribe
  on `host:session-start` / `host:session-switch`; those events are the
  invalidation signal;
- `/reload` continues to rebuild the host against the *current* session key.

## Phase 2 — TUI

- `/new [name]` — new empty session (fresh key `cwd:<path>#<id>`), guard-
  checked, recorded active.
- `/resume` — opens an interactive picker (switch, rename, delete —
  deleting the session driving the live thread is blocked); with an
  argument it switches directly by exact key, unique name, or unique
  prefix, with argument completions backed by the index. Embedded hosts
  without an interactive UI fall back to a plain listing.
- Session recency (`updatedAt`) bumps on every completed turn and on
  `/clear`, so picker ordering reflects actual use.
- `/name <name>` and the `--name <name>` startup flag — display name,
  shown in the header subtitle.
- `/fork` — branches the source thread into a new key and records
  `parentKey`. Without arguments an interactive picker offers the latest
  state plus every stored user message as a branch point; branching before
  a message re-encodes the truncated history and keeps only compaction
  records that fit inside it. Either way `appliedMigrations` carries over,
  so #256 migrations never re-run on the fork. `/fork <name>` forks at the
  latest state under that name.
- `/clear [name]` is a compatibility alias for `/new [name]`: it creates and
  switches to a new session without deleting the previous one. Both spellings
  emit the normal `new` lifecycle reason; `clear` remains in the reason type so
  older extension hosts can decode persisted/third-party events, but the built-in
  command no longer emits it.
- `new`, `resume`, `name`, `fork` (plus the previously reserved names) are
  reserved: extensions cannot register them.

## Fork semantics

A head fork copies the stored thread state verbatim to the new key. A fork
*before an earlier user message* uses the runtime's snapshot codecs
(`decodeStoredThreadState` / `encodeThreadSnapshot`, exported for this) to
re-encode the validated history prefix: the fork keeps messages strictly
before the chosen user message, drops compaction records that extend past
the cut, and seeds `appliedMigrations` unchanged. The fork point must
reference a user message; anything else is rejected before any state is
written, and a fork whose metadata registration fails deletes its copied
thread so no orphan state remains.
