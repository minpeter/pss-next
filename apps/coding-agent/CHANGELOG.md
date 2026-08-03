## @minpeter/pss-coding-agent@0.0.14-next.7 (next)

### Stabilize package timeout testing

Give spawned test processes enough startup time on loaded CI runners while preserving coverage of forced descendant termination.

## @minpeter/pss-coding-agent@0.0.14-next.6 (next)

### Load AGENTS.md context files, prompt templates, and skills

pss now loads file-based context resources without requiring an extension.
`AGENTS.md` context files are discovered from `~/.pss/AGENTS.md` and from
the repository root (the first ancestor containing `.git`) down to the
working directory, closest file last, and injected into the system prompt
in both the TUI and headless exec.

Prompt templates (`~/.pss/prompts/*.md` globally,
`<project>/.pss/prompts/*.md` trust-gated per project) become `/name`
slash commands in the TUI and expand `pss exec` prompts of the form
`/name args`. `$ARGUMENTS` receives the full argument string and
`$1`–`$9` positional arguments in a single substitution pass, so
placeholder-like text inside arguments is never re-substituted; bodies
without placeholders get the arguments appended. An optional
`description:` frontmatter line labels the command. Built-in and extension
commands always win name collisions; shadowed templates are skipped with a
notice, and project templates beat global ones, which beat
extension-contributed ones.

Skills are `skills/<name>/SKILL.md` directories with `name`/`description`
frontmatter, discovered globally and (trust-gated) per project. Only the
metadata loads eagerly; the system prompt lists each skill and the model
reads the `SKILL.md` on demand when a task matches.

Extensions contribute prompt and skill directories with the new
`resources` capability (absolute paths, validated). Untrusted project
resources stay blocked with a notice — the same trust gate the extension
loader uses — and malformed trust settings fail safe. Context resources
are re-discovered by `/reload`, so edits apply without a restart; a failed
reload keeps the previous resources with the previous runtime.

### Stage /reload extension imports in an isolated module context

`/reload` now evaluates every replacement extension candidate in a
worker-thread module context before anything in the live process is
touched. A candidate that throws at module scope, or exports the wrong
shape, fails the reload during staging — so the live runtime's ESM module
graph and CommonJS cache are only modified once all candidates load
cleanly, and a rolled-back reload can no longer leave freshly re-executed
helper instances observable to the still-running previous runtime through
that window. The staging worker reports the observed export shape
(factory, extension object, or invalid), letting loader validation fail at
staging time exactly as the commit-time import would.

Module side effects run once in the discarded worker context and once more
at commit time; staging trades that repeat execution for keeping the live
module graph untouched on failure. The staging worker keeps the process
alive only while imports are in flight and is terminated when the staging
session ends, and remaining commit-time failures (for example an
activation error after a clean import) continue to use the transactional
CommonJS snapshot/rollback.

### Manage named, resumable, forkable sessions with lifecycle events

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

### Tighten model options and remove stale internal code

Model-catalog cache configuration is now exposed only by coding-model session
factories, where it is actually used. The native language-model factories no
longer advertise and silently forward a no-op `catalogCache` option, while the
new session-specific option types preserve explicit cache configuration for
embedders and tests. Shared provider construction also keeps native and
switchable model setup from drifting apart.

Remove an unused copied TUI color palette, three orphaned image-codec
initialization promises, a dead test fixture, and a mismatched image-codec
comment. Repository TypeScript checks now reject unused locals and parameters,
and workspace/Biome metadata is kept aligned with the active pnpm workspace and
tool versions.

### Default to minimax/MiniMax-M3

The fallback model id used when `AI_MODEL` is unset moves from
`minimax/MiniMax-M2.7` to `minimax/MiniMax-M3`. Set `AI_MODEL` to pin the
previous model.

### Render LaTeX display math through an overridable extension

Assistant `$$ ... $$` and `\[ ... \]` display blocks now render through
LaTeX, DVI, `dvipng`, and ImageMagick into cached transparent PNGs in
Kitty-graphics terminals. The renderer preserves incomplete or invalid source
as Markdown, repairs common single-backslash row terminators, keeps
high-resolution source images at terminal-sized logical dimensions, and
deduplicates missing-dependency notices for the lifetime of the TUI session.
Formula scale and terminal-specific horizontal correction are configurable
with `PSS_LATEX_SCALE` and `PSS_LATEX_ASPECT`.

The implementation ships as the independently versioned
`@minpeter/pss-extension-latex` package, which coding-agent includes by
default. The assistant-renderer capability now exposes lifecycle cancellation,
disposal, redraw, notification, ownership, conflict, and reload boundaries.
Official LaTeX registers as a fallback; third-party renderers must explicitly
opt into replacing it, and removing an override restores the official
renderer.

Native rendering uses an allowlisted environment, bounded queue and cache
reads, process-tree cancellation, PNG dimension limits, disabled
Ghostscript/raw-PostScript paths, and per-stage time and output limits. It runs
only on Linux with Bubblewrap namespace/filesystem isolation and `prlimit`
resource bounds available; otherwise the original Markdown remains visible.

### License the workspace under the Sustainable Use License

The repository previously shipped without a license file, leaving published
packages with no stated terms. `LICENSE.md` now declares the Sustainable Use
License 1.0 at the workspace root and is mirrored into the two published
packages, which set `"license": "SEE LICENSE IN LICENSE.md"` and include the
file in their published `files` list.

Internal business, non-commercial, and personal use stay free, including
modification and free redistribution. Reselling the software or offering it as
a paid product or service requires a separate commercial license.

The license applies retroactively to every earlier release, including the ones
published with no license field, so previously installed versions are covered by
the same terms instead of being left unlicensed.

### Update the AI SDK

Update the runtime, coding agent, and web extension to AI SDK 7.0.45.

### Harden file ownership and extension mutation transactions

Replace time-expiring local file leases with atomic PID/token-owned locks.
Live processes retain ownership even while suspended, dead owners are reaped
under a separately owned lock, and stale holders cannot release a successor's
lock. The lock explicitly targets one shared PID namespace and a local
filesystem rather than claiming cross-container or distributed-filesystem
safety.

Serialize each extension scope's install, update, remove, enable, and trust
mutations through one operation owner. Package updates validate before
mutation and restore a single install-root snapshot if any package or final
settings commit fails; failed removals likewise restore package bytes before
restoring settings, and failed project trust restores the prior enabled state.
Package-manager subprocesses now have bounded output, a configurable deadline,
and process-group SIGTERM/SIGKILL escalation where supported.

Reload staging now rejects candidate graphs that introduce extension-owned
CommonJS modules before importing them into the live process. Existing
CommonJS cache entries return a restart-required result instead of attempting
unsafe process-wide cache eviction, while ESM reload remains supported.

### Make edit_file anchors symmetric

Use `target` for one line or `first` and `last` for ranges, with non-empty `new_content`.
Align the edit benchmarks with the real tool contract and add deterministic multi-file recovery coverage.

### Extract the coding agent's web tools into an extension

Move `web_search`, `web_fetch`, their OpenSearch integration, and TUI renderers
into a default `@minpeter/pss-extension-web` package while preserving existing overrides and headless defaults.

## @minpeter/pss-coding-agent@0.0.14-next.5 (next)

### Add hashline edit diffs to the coding-agent TUI

The coding agent now renders anchored `edit_file` results as sorted,
senpi-style word diffs with faint changed regions, stronger intra-token
highlights, and dim context rows for unchanged lines.

The TUI modules are organized by code flow under `src/tui/`, and read/diff
rendering now displays terminal control characters as safe visible
placeholders instead of forwarding them to the terminal.

### Add the core hooks runtime and installable coding-agent extensions

Replace the legacy runtime plugin pipeline with one typed `AgentHooks`
boundary for model transforms and tool interception. Stored thread snapshots
can now run versioned, atomic migrations that persist exactly-once application
metadata without exposing partial state after callback or commit failures.

Coding-agent extensions can be authored as default-export factories receiving
`ExtensionAPI`, while static programmatic extensions remain supported. The
host composes instructions, tools, commands, UI contributions, lifecycle
callbacks, runtime hooks, and durable thread migrations with source-attributed
validation errors. Concise `pss.use()`, `pss.on()`, and `pss.provide()` methods
register control hooks, named event observers, and branded capabilities for
instructions, tools, commands, migrations, and renderers without restoring
the legacy plugin runtime. Factory capabilities validate and publish
atomically after configuration succeeds.

Add `pss extension install`, `list`, `remove`, `update`, `enable`, and
`disable` for npm, Git, local package, and loose ESM sources at global or
project scope. Trusted project discovery loads extensions consistently in the
TUI and headless exec runner. Managed installs validate package boundaries,
reject symlink and export-path escapes, disable lifecycle scripts, and restore
the prior package and settings state when installation, update, or trust
recording fails.

### Add /reload, an inter-extension event bus, and provider observations

The TUI gains a `/reload` command that rebuilds the extension runtime from
disk without restarting the session. Extensions are rediscovered across
managed installs, local modules, and `-e` paths, re-imported past the module
cache, and activated against a replacement agent while the durable thread
keeps its history. Reload is staged for safety: discovery, configuration,
validation, and agent construction happen while the previous runtime keeps
running, the previous runtime is then disposed under a bounded timeout
before the replacement activates (so old cleanup can never overwrite the
replacement's extension state), and an activation failure rebuilds a
runtime from the previous extensions so the session stays usable. Cache
busting propagates through the extension-owned module graph via a module
customization hook, including CommonJS helpers and a managed package's own
modules; CommonJS eviction is transactional and restored when a reload
fails, and dependency trees under `node_modules` keep their loaded versions
so repeated reloads do not accumulate duplicate dependency graphs. The
runtime exports `commitThreadStateMigrations`, which `/reload` uses to run
and commit reloaded migrations for the stored thread before the swap,
preserving exactly-once migration semantics; a failed reload also refreshes
the surviving thread handle so it cannot commit on a stale revision. The
command is offered only when the host can rediscover extensions, and
`reload` joins the reserved command names extensions cannot register.

Extension services gain `services.events`, a shared publish/subscribe bus
for extension-to-extension communication. Payloads are JSON values cloned
per delivery, delivery is deferred so synchronous handler work cannot block
the publisher, handlers run under the host timeout/abort boundary, and
failures are attributed to the subscribing extension without affecting the
publisher or other subscribers. The `host:` and `provider:` namespaces are
reserved for host-originated events.

The host now publishes read-only provider HTTP observations on the bus:
`provider:request`, `provider:response`, and `provider:error`. URLs are
stripped of credentials, query strings, and fragments, request bodies and
request headers are never exposed, response headers pass a safelist, and
transport error messages are scrubbed of URL-like tokens. Observation
failures never interrupt provider traffic, and both the TUI and headless
exec wire the observation fetch automatically.

### Load local extensions without installing

Loose extension modules now load automatically from
`~/.pss/extensions/<name>.<ts|mts|js|mjs>` and
`~/.pss/extensions/<name>/index.*`, plus the project-scoped
`<project>/.pss/extensions/` once the project is trusted. TypeScript modules
run directly through Node's native type stripping, so authoring an extension
needs no packaging or build step. File and directory names become the stable
extension id and must match `[a-z0-9][a-z0-9._-]*`; symbolic links and invalid
names are skipped with startup notices instead of failing startup.

Managed installs keep precedence: a local module whose id collides with an
installed extension is skipped with a notice, and project-local modules
override global-local modules with the same id. Untrusted projects that
contain loose extension modules surface the existing blocked-extensions
notice.

Add a repeatable `-e`/`--extension <path>` flag to the TUI and `pss exec` that
loads a module file or index directory for the current run only, without
touching settings. CLI extensions are an explicit user action, so they load
without trust gating and take precedence over configured extensions with the
same id. Invalid paths, non-module files, duplicate ids, and missing index
modules fail fast with actionable errors before the session starts.

### Delegate web tool providers to OpenSearch instead of gating on TinyFish

`createCodingAgentTools()` no longer gates `web_search`/`web_fetch` behind
`TINYFISH_API_KEY`. Provider selection is delegated to
`@minpeter/opensearch`, which resolves keyed engines (TinyFish, Exa, Brave,
Tavily, ...) from the environment and always has keyless fallbacks such as
DuckDuckGo search and local fetch, so the tools register whenever
`webToolsAvailability` is not `disabled`.

The now-dead missing-key surface is removed: `WEB_TOOLS_DISABLED_MESSAGE`,
`CodingAgentWebToolsUnavailableError`, and the `onWebToolsDisabled` option are
gone, and the TUI no longer emits a startup notice for a missing key. The
`webToolsAvailability` type and the `pss exec --web-tools` flag keep accepting
`disabled|optional|required` (`optional` and `required` now behave the same),
and `pss exec` still defaults to `disabled`.

## @minpeter/pss-coding-agent@0.0.14-next.4 (next)

### Add workspace coding tools and the headless `pss exec` runner

The coding agent now ships a workspace tool set shared by the TUI and a new
headless runner: `read_file`, `glob_files`, `grep_files`, `edit_file`
(hashline-anchored with stale-hash guards), `write_file`, `delete_file`, and
`shell_execute`. The file tools are confined to the workspace — path and
symlink escapes are rejected — and writes are atomic with the target
permissions applied from the outset. `shell_execute` is not a sandbox:
commands run with the user's permissions, but AI provider API keys are
withheld from the child environment.

`pss exec` runs one headless coding task for CI, benchmarks, and scripts. It
streams JSONL events (`metadata`, `agent_event`, `result`) to stdout and
exits 0 only when the task completes, with `--workspace`, exactly one of
`--prompt`/`--prompt-file`/`--stdin`, plus `--model`, `--base-url`,
`--timeout-seconds`, `--web-tools`, and `--result-file`. A `.env` next to the
working directory is loaded automatically.

Both surfaces share one production agent factory, `createCodingAgent`: the
workspace tools are always included and win name collisions, while a custom
`tools` option replaces only the optional web tools.

## @minpeter/pss-coding-agent@0.0.14-next.3 (next)

### Add update notices and the `pss update` command

The TUI now checks for updates without blocking startup: a cached registry
result in `~/.pss/update-check.json` (24h TTL, written atomically) is read
before the first render, one dim scrollback line announces a newer version
when present, and a stale cache refreshes in the background after the first
render so the startup path performs no network I/O. The version and channel
(`latest` or `next`) are baked at build time, checks skip dev/source runs,
and `PSS_DISABLE_UPDATE_CHECK=1` opts out.

`pss update` re-checks the npm registry's dist-tags and installs the
exact pinned version through the detected package manager. Channels follow
the installed version: stable installs track `latest`, and any prerelease
tracks its own dist-tag (`next`, `beta`, `canary`, or any published tag),
with explicit `--channel <tag>` moves allowed toward stable or across
prerelease channels and refused from stable to prerelease. Package managers
(pnpm/npm/bun/yarn today) are described in a single descriptor registry —
detection patterns, probes, and install arguments — so new managers are one
data entry. dlx/npx/bunx one-off runs and unknown layouts are refused with
manual instructions. `pss update --check` prints the current version,
channel, install method, and the exact command without changing anything.

With `PSS_AUTO_UPDATE=1`, an in-channel, same-major update on a
confidently detected global install is installed automatically after the TUI
exits — never during a session and never as a channel switch.

The TUI web-tools availability warning now renders through the same dim
scrollback seam instead of a pre-start `console.warn`.

## @minpeter/pss-coding-agent@0.0.14-next.2 (next)

### Remove legacy negative assertions and orphan probe script

Drop test-only assertions that verify already-removed legacy APIs
(`createCloudflareAgentsHost`, `PSS_SESSION_*` env aliases, object-style
plugin pipeline, legacy `llm`/`description`/`sessions` option fields) do not
exist. The APIs themselves were removed in prior releases; these negative
checks no longer guard a live migration boundary.

Also delete `scripts/probe-cache-stable-response-shape.mts`, a one-off
investigation script not referenced by any npm script or test.

No API or behavior change.

## @minpeter/pss-coding-agent@0.0.14-next.1 (next)

### Remove Cloudflare host and `PSS_SESSION_*` aliases

Drop `createCloudflareAgentsHost`, `CloudflareHostAgentsOptions`, and
`CloudflareAgentsHostOptions`. Use `createCloudflareHost` /
`CloudflareHostOptions` only.

Coding-agent env falls back only on `PSS_THREAD_DIR` / `PSS_THREAD_KEY`;
`PSS_SESSION_DIR` / `PSS_SESSION_KEY` are no longer accepted.

# @minpeter/pss-coding-agent

## 0.0.13

### Patch Changes

- Updated dependencies [496e522]
- Updated dependencies [7c4bb7e]
- Updated dependencies [d8e36b7]
  - @minpeter/pss-runtime@0.2.0

## 0.0.12

### Patch Changes

- bf07086: Add `help`/`--help`/`-h` to the `pss` CLI and make unknown commands print usage and exit with code 1 instead of throwing.
- 4c50311: Add local thread compaction configuration and inspection support to the coding
  agent CLI.

  The TUI now shows the active thread key and auto-compaction policy, accepts
  `PSS_THREAD_*` storage settings with legacy `PSS_SESSION_*` aliases, and can
  enable runtime auto-compaction through `PSS_AUTO_COMPACTION_MIN_MESSAGES` plus
  `PSS_AUTO_COMPACTION_RETAIN_MESSAGES`. The CLI also adds `pss inspect-thread`
  for checking the configured local thread file without starting the TUI. The
  coding agent now uses the runtime Node platform host and runtime-owned file
  thread inspection helper for local thread storage.

- 617b9f9: Refresh dependencies across the v0.1 workspace, including AI SDK 7 latest.
- e8bd679: Remove the built-in web tools from the coding-agent package and TUI. Callers can still pass their own tools through `@minpeter/pss-runtime`.
- Sync dependency updates from main into the v0.1 prerelease line.
- 1dd09de: Replace the public `agent.session(key)` entrypoint with `agent.thread(key)`.
  Threads are the app-facing conversation unit; runtime session state remains an
  internal storage concern behind the thread handle. `agent.thread({ key, scope })`
  now provides an optional scoped address for multi-user integrations while
  preserving opaque session storage under the host boundary.

  Rename execution, Cloudflare scheduling, and notification APIs from
  `sessionKey`/`resumeSession`/scheduled session prompts to
  `threadKey`/`resumeThread`/scheduled thread prompts so edge apps can model
  linear conversation history without leaking storage-session terminology.

- Updated dependencies [e989f88]
- Updated dependencies [5cc6285]
- Updated dependencies [4a2ab2b]
- Updated dependencies [d1c015c]
- Updated dependencies [74dc8de]
- Updated dependencies [320c01c]
- Updated dependencies [617b9f9]
- Updated dependencies [b03d3ac]
- Updated dependencies [836a1c4]
- Updated dependencies [1f3a46c]
- Updated dependencies [41736e7]
- Updated dependencies [7346750]
- Updated dependencies [b21c318]
- Updated dependencies [fedd6be]
- Updated dependencies [b03d3ac]
- Updated dependencies [0ffe9e7]
- Updated dependencies [515b089]
- Updated dependencies [c8bf377]
- Updated dependencies [a5418f0]
- Updated dependencies [ae58a13]
- Updated dependencies [f3c4461]
- Updated dependencies [d1e0186]
- Updated dependencies [ae8de0e]
- Updated dependencies [641ccbf]
- Updated dependencies [8c3e696]
- Updated dependencies [307f8fd]
- Updated dependencies [0a1f556]
- Updated dependencies [b687931]
- Updated dependencies
- Updated dependencies [1dd09de]
- Updated dependencies [a58c756]
- Updated dependencies [11dd14d]
  - @minpeter/pss-runtime@0.1.0

## 0.0.11-next.5

### Patch Changes

- 617b9f9: Refresh dependencies across the v0.1 workspace, including AI SDK 7 latest.
- Updated dependencies [617b9f9]
- Updated dependencies [7346750]
- Updated dependencies [11dd14d]
  - @minpeter/pss-runtime@0.1.0-next.24

## 0.0.11-next.4

### Patch Changes

- bf07086: Add `help`/`--help`/`-h` to the `pss` CLI and make unknown commands print usage and exit with code 1 instead of throwing.
- 4c50311: Add local thread compaction configuration and inspection support to the coding
  agent CLI.

  The TUI now shows the active thread key and auto-compaction policy, accepts
  `PSS_THREAD_*` storage settings with legacy `PSS_SESSION_*` aliases, and can
  enable runtime auto-compaction through `PSS_AUTO_COMPACTION_MIN_MESSAGES` plus
  `PSS_AUTO_COMPACTION_RETAIN_MESSAGES`. The CLI also adds `pss inspect-thread`
  for checking the configured local thread file without starting the TUI. The
  coding agent now uses the runtime Node platform host and runtime-owned file
  thread inspection helper for local thread storage.

- Updated dependencies [836a1c4]
- Updated dependencies [fedd6be]
  - @minpeter/pss-runtime@0.1.0-next.23

## 0.0.11-next.3

### Patch Changes

- Harden Cloudflare Durable Object storage for long-running agent threads and
  rename the runtime domain from sessions to threads. Runtime storage now rejects
  oversized single-row payloads before Durable Object writes, stores tool
  checkpoints as bounded thread references instead of full history snapshots, and
  uses a SQLite row queue for scheduled Cloudflare work.

  The public app-facing API now uses `agent.thread(...)`, `ThreadInput`, and
  ThreadStore names. Deprecated Session aliases remain as explicit compatibility
  adapters, while the coding-agent local thread store imports have moved to the
  new thread-store subpaths.

- Updated dependencies
  - @minpeter/pss-runtime@0.1.0-next.11

## 0.0.11-next.2

### Patch Changes

- 1dd09de: Replace the public `agent.session(key)` entrypoint with `agent.thread(key)`.
  Threads are the app-facing conversation unit; runtime session state remains an
  internal storage concern behind the thread handle. `agent.thread({ key, scope })`
  now provides an optional scoped address for multi-user integrations while
  preserving opaque session storage under the host boundary.
- Updated dependencies [4a2ab2b]
- Updated dependencies [1dd09de]
  - @minpeter/pss-runtime@0.1.0-next.9

## 0.0.11-next.1

### Patch Changes

- Sync dependency updates from main into the v0.1 prerelease line.
- Updated dependencies
  - @minpeter/pss-runtime@0.1.0-next.6

## 0.0.11-next.0

### Patch Changes

- e8bd679: Remove the built-in web tools from the coding-agent package and TUI. Callers can still pass their own tools through `@minpeter/pss-runtime`.
- Updated dependencies [0ffe9e7]
- Updated dependencies [3761c93]
  - @minpeter/pss-runtime@0.1.0-next.0

## 0.0.10

### Patch Changes

- 92af1da: Update the coding-agent TUI dependency range to pick up the latest `@earendil-works/pi-tui` release.
- Updated dependencies [5fc427d]
  - @minpeter/pss-runtime@0.0.10

## 0.0.9

### Patch Changes

- 20103d2: Make the coding-agent TUI subpath import-safe, correct multimodal docs, and remove redundant runtime type exports.
- Updated dependencies [20103d2]
  - @minpeter/pss-runtime@0.0.9

## 0.0.8

### Patch Changes

- c991a6a: Replace the public current-turn input API with `session.steer(input)` and keep
  `session.send(input)` as the new-turn queue. Active TUI submissions now steer the
  current run through the session API.
- Updated dependencies [c991a6a]
  - @minpeter/pss-runtime@0.0.8

## 0.0.7

### Patch Changes

- Updated dependencies [c71ea7d]
  - @minpeter/pss-runtime@0.0.7

## 0.0.6

### Patch Changes

- Updated dependencies [37a14b9]
- Updated dependencies [37a14b9]
- Updated dependencies [1b43c77]
  - @minpeter/pss-runtime@0.0.6

## 0.0.5

### Patch Changes

- fbe0448: Make agent sessions runtime-owned and durable through an opaque session store boundary, including memory/file stores and coding-agent TUI file-backed sessions.
- Updated dependencies [fbe0448]
  - @minpeter/pss-runtime@0.0.5

## 0.0.4

### Patch Changes

- Updated dependencies [23cce55]
  - @minpeter/pss-runtime@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [c5b7c8b]
  - @minpeter/pss-runtime@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [f503ccd]
  - @minpeter/pss-runtime@0.0.2

## 0.0.1

### Patch Changes

- 990086e: Add the publishable `pss` CLI entrypoint for global installs and package runners.
- 8f03383: Publish the initial pss-next runtime and coding-agent packages from the new Turborepo workspace.
- Updated dependencies [8f03383]
  - @minpeter/pss-runtime@0.0.1
