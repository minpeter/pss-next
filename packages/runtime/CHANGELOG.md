## @minpeter/pss-runtime@0.3.0-next.18 (next)

### Harden thread and session lifecycle ownership

Retain the authoritative thread handle when deletion fails, and remove the
destructive behavior of the deprecated `new-session` extension action. Existing
extensions remain source-compatible, but hosts now ignore that action; use the
built-in `/new` or `/clear` command for guarded session replacement.

### Surface provider call attempts as runtime events

Emit an ephemeral `model-attempt` agent event for every physical provider call
in a model step, including retries performed beneath both `streamText` and
`generateText`. Each event carries the step's `attemptId`, a 1-based `attempt`
counter, and a start/end phase. The end event reports the outcome and, when
measurable, the duration of that provider call excluding retry backoff. Failed
attempts also report a normalized provider error when it can be classified,
including failures that the AI SDK subsequently retries. Hosts that already
consume stream events receive these automatically; the committed `model-usage`
event remains the durable successful-step record. Object models and string ids
resolved by a configured `AI_SDK_DEFAULT_PROVIDER` are observed. String ids
resolved through the SDK's implicit gateway emit no attempt events because its
resolved model and individual retry failures are not exposed.

Extensions can subscribe to the new event through
`pss.on("model-attempt", ...)`, which previously threw for this event id, and
headless coding-agent runs forward it on their live NDJSON stream. The event is
live-only and never lands in durable history or headless result payloads.

### Workspace source exports

Place the opt-in `@minpeter/pss-source` workspace source condition before `types` in package exports.
Default published consumers continue to resolve declarations and JavaScript from `dist`.

## @minpeter/pss-runtime@0.3.0-next.17 (next)

### Fail closed on missing checkpoints

Checkpoint adapters now surface checkpoint corruption when authoritative run metadata references a missing checkpoint, preventing resume from silently restarting at step one.

### Keep restarted drain turns successful

Wait for a requested queue-drain restart before settling joined callers, so a
queued turn cannot receive a failure and then execute anyway.

### Support web and edge runtime timers

Guard detached compaction timer `unref` calls so numeric web timer handles do not crash summary startup or cleanup.

### Let the TUI exit while selectors are pending

Cancel pending model and session selector waits when exit is requested so catalog loading or an open picker cannot keep the process alive.

## @minpeter/pss-runtime@0.3.0-next.16 (next)

### Fence durable run ownership

Unify claim semantics across execution stores and reject run transitions or
checkpoint writes from stale lease owners.

### Measure prompt tokens in serialized UTF-8 bytes

Default prompt measurement counted UTF-16 code units, so CJK text cost the
same units as ASCII of equal length. Adaptive calibration learned an inflated
marginal scale from CJK requests and applied it to every later request,
including ASCII prose and tool results, which could reject prompts that fit.
Measurement now divides serialized UTF-8 byte length by four. ASCII estimates
are unchanged; non-ASCII estimates increase and never decrease relative to the
previous basis.

### Configure the context gate independently

`createAgent` now accepts an explicit `contextGate` that takes whole-object precedence over compaction budget metadata without changing speculative compaction thresholds.

### Advance overflow compaction past tool-heavy turns

When backward range selection collapses inside a tool exchange, compaction now advances to the next valid boundary without weakening tool-exchange integrity.

### Reuse speculative summaries across thread reconstruction

Process-local speculative candidates now survive same-Agent thread reconstruction in a bounded cache while remaining isolated when a compaction policy is shared by multiple Agents.

### Isolate detached compaction summaries

Prevent summaries produced from transformed or unknown model context from becoming reusable by later standard-context compaction episodes.

## @minpeter/pss-runtime@0.3.0-next.15 (next)

### Reorganize Durable Object platforms

Move shared Durable Object storage, SQLite, and scheduled-work primitives into
a neutral platform core, with Cloudflare and Celld as sibling implementations.
Replace the former Cloudflare and Celld package paths with the new hierarchy.

## @minpeter/pss-runtime@0.3.0-next.14 (next)

### Add Celld platform compatibility

Add a structural Celld host and alarm-backed scheduled-work adapter for
self-hosted Durable Objects deployments, with local native and container QA.

### Add complete Celld validation coverage

Exercise real-agent durability, scheduler chaos, native performance profiles,
and loopback S3 fault injection while fixing scheduler boundaries proven by the
campaign.

## @minpeter/pss-runtime@0.3.0-next.13 (next)

### Bound automatic compaction blocking

Enforce one deadline at the serialized store boundary, preserve compatible
conflict tails, coalesce retries, and reuse only source-stable candidates.
Bound diagnostics and add causal benchmark evidence.

### TypeScript strictness

Enforce `exactOptionalPropertyTypes` for the runtime OpenTelemetry subsystem and preserve absent optional OpenTelemetry fields instead of materializing `undefined`.

### Detached compaction summaries outlive episode deadlines

A compaction episode deadline now bounds only the caller's wait, not the
provider work: an in-flight summary continues detached after
`CompactionDeadlineExceededError`, installs as a fail-closed validated
speculative candidate, and the next episode joins or promotes it without a
second summary call. Detached calls are single-flight per thread, honour
explicit summary signals, and carry a fixed 120s leak backstop
(`DETACHED_SUMMARY_BACKSTOP_MS`). Slow models converge across episodes
instead of restarting aborted summaries every episode.

## @minpeter/pss-runtime@0.3.0-next.12 (next)

### Carry the compaction budget as function properties

The `compaction` option is a single callable type again: `AgentCompaction` gains optional budget properties (`maxInputTokens`, `estimateTokens`, `bufferTokens`, `onOverflow`), and when `maxInputTokens` is present the runtime hands the function itself to the model-step context gate, which calls it before every model request. `speculativeCompaction` returns the callable with its budget attached; `AgentCompactionPolicy` and the interim policy-object form from 0.3.0-next.11 are removed. Bare functions without budget properties keep the local gate off.

## @minpeter/pss-runtime@0.3.0-next.11 (next)

### Turn compaction into budget-owning policy objects

`createAgent` accepts a compaction policy object carrying the context budget it compacts toward; the model-step context gate calls the policy's `maxInputTokens()` before every model request, so custom compaction and the gate can no longer drift apart. `speculativeCompaction` returns such a policy, and `contextGateForCompaction`/`estimatorForCompaction`/`DEFAULT_AGENT_MAX_INPUT_TOKENS` are removed: a bare `AgentCompaction` function now runs with the local gate off (provider-overflow-reactive compaction only) instead of a silent 128K fallback budget. A policy without `compact` is a budget-only source; pair it with `onOverflow: "error"` to fail over-budget turns without rewriting history.

## @minpeter/pss-runtime@0.3.0-next.10 (next)

### Add AgentHost fault-injection conformance coverage

Add reusable AgentHost fault-injection conformance coverage for durable cursors, leases, inputs, checkpoints, and transaction crash boundaries across memory, file, and Cloudflare hosts.

### Harden published-package release gates

Validate published package metadata and packed-tarball imports in the release gate, and ship a stable `pss-eval` bin wrapper that avoids missing-bin install warnings before builds.

### Preserve falsy buffered turn errors as rejections

Separate successful and failed buffered turn closure so every JavaScript falsy value remains observable as an iterator rejection.

### Add durable followUp turns with recovery

Add durable `followUp` turns with recovery and distinct metadata. FIFO one-at-a-time execution applies within one process/isolate to handles sharing the exact store wrapper.

### Scope event cursors nominally and validate offsets

Scope run and thread event cursors nominally and validate cursor offsets and replay limits consistently across storage backends.

### Add the versioned JSONL agent protocol

Add a versioned transport-neutral JSONL RPC protocol, TypeScript client, and Node spawn transport.
Expose coding-agent prompt, steer, abort, and state operations through a protocol-clean stdio mode.

### Harden notification retry handling

Prevent idempotent notification retries from rescheduling terminal runs and fail safely when deduplicated notification records are missing or inconsistent.

### Remove dead runtime declarations

Remove verified unused runtime declarations and internal test helpers.

### Add session TUI compaction parity

Add explicit `/compact` and Pi-compatible `/session` commands to the interactive TUI, with runtime-owned durable context compaction and documented session UX.

### Add the SQL + durable queue host

Add platform-neutral SQL store and leased durable-queue integration ports, worker draining, and exact-work outbox reconciliation with in-memory reference contract coverage.

## @minpeter/pss-runtime@0.3.0-next.9 (next)

### Strengthen runtime indexed access checks

Type-check shipped runtime source with `noUncheckedIndexedAccess` and document the staged exact-optional migration baseline without diagnostic suppressions.

## @minpeter/pss-runtime@0.3.0-next.8 (next)

### Update the agents SDK

Bump the Cloudflare agents SDK from 0.20.0 to 0.20.1 in the runtime and worker agent.

### Update the chat adapter stack

Bump chat, @chat-adapter/telegram, and @chat-adapter/state-memory to 4.36.0 together so the worker agent adapter types stay aligned.

### Update Cloudflare Workers type definitions

Refresh the worker agent and edge QA projects to Cloudflare Workers types 5.20260801.1.

### Update the hashline edit format

Bump @oh-my-pi/hashline to 17.2.4 and update the edit-format bench for the renamed DSL operations (PUT/CUT).

### Update the pnpm setup GitHub Action

Bump pnpm/action-setup from 6 to 6.0.9 across the CI and release workflows.

### Update the React dev dependency

Bump the workspace React dev dependency from 19.2.7 to 19.2.8.

### Pack all extensions in the release dependency check

Pack the latex and mermaid extensions alongside web in the release
workflow's coding-agent dependency resolution check, fixing the npm E404
on the never-published @minpeter/pss-extension-mermaid.

### Update wrangler

Bump the wrangler dev dependency from 4.114.0 to 4.118.0 in the worker agent and edge QA projects.

## @minpeter/pss-runtime@0.3.0-next.7 (next)

### Harden thread storage lifecycle

Make Durable Object thread schema migration idempotent and add aggregate thread deletion that removes runtime-owned snapshots, events, runs, notifications, scheduled work, and payload chunks.

### Update the AI SDK

Update runtime and consumer packages to AI SDK 7.0.51 for consistent tool types and downstream version alignment.

## @minpeter/pss-runtime@0.3.0-next.6 (next)

### Add speculative background compaction

Replace the legacy auto-compaction options with a callable compaction policy
and add a speculative strategy that prepares summaries before promotion.
Preserve overflow recovery, hook interception, and stale-commit protection.

## @minpeter/pss-runtime@0.3.0-next.5 (next)

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

### Prepare fresh Amp orbs for development

Install the pinned Node and pnpm toolchain, workspace dependencies, and Chromium in fresh Amp orbs, with a fast wake-up lifecycle.

### Update Cloudflare Workers type definitions

Refresh the Worker and edge QA projects to the latest Cloudflare runtime type definitions.

### Document the pull request Tegami policy

Require pull requests to include a concise Tegami entry before merge and use
patch-level releases by default unless another release level is requested.

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

## @minpeter/pss-runtime@0.3.0-next.4 (next)

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

## @minpeter/pss-runtime@0.3.0-next.3 (next)

### Move extension composition out of the runtime core

Replace the runtime factory extension kernel with one application-owned
`AgentHooks` callback object. Preserve atomic input, turn, model, tool, and
compaction interception while removing core ownership of extension identity,
ordering, lifecycle, tools, and state.

Move multi-extension composition to
`@minpeter/pss-coding-agent/extension`, including stable IDs, bounded
configuration and activation, reverse cleanup, runtime hook chaining, tools,
instruction fragments, commands, and TUI tool renderers.

### Add the app-owned channel adapter contract

Expose `@minpeter/pss-runtime/channel` with typed inbound channel messages and
assistant text deliveries. Apps retain ownership of provider mapping, the
`Agent -> Thread -> Turn -> events()` control flow, and outbound delivery.

`projectChannelAssistantDelivery(event)` projects only non-empty
`assistant-output` events. The runtime does not add provider adapters or own a
channel loop.

### Inspect durable turn lifecycle by run ID

Expose a stable optional `AgentTurn.runId` for durable work accepted by an
execution host. Precreate queued user-turn runs after durable input admission,
carry the same run through execution and checkpoints, and bind resumed
notifications to the run ID returned by `dispatchAgentNotification`.

Add read-only `inspectDurableTurn(source, runId)` to the existing `./execution`
subpath. Recorded runs report status, thread key, checkpoint version, and the
latest checkpoint, with explicit unsupported, unknown-run, and no-checkpoint
states.

Make thread shutdown await durable cancellation of queued, active, and
admission-racing runs while preserving completed, failed, recovery, and already
cancelled terminal statuses.

### Add OpenTelemetry turn tracing

Add the `@minpeter/pss-runtime/otel` subpath with `traceAgentTurn()` for one
turn and `openTelemetry()` for agent-wide instrumentation. Record turn, step,
and tool spans plus metadata-only runtime events through
`@opentelemetry/api`, leaving SDK and exporter configuration to applications.

Expose general `AgentOptions.instrumentations` hooks for send, steer, and
resume operations. Wrapped turns preserve single-consumption and pass through
every original event, including model-usage telemetry, while payload summaries
avoid raw content and do not invoke `toJSON()`.

### Remove legacy negative assertions and orphan probe script

Drop test-only assertions that verify already-removed legacy APIs
(`createCloudflareAgentsHost`, `PSS_SESSION_*` env aliases, object-style
plugin pipeline, legacy `llm`/`description`/`sessions` option fields) do not
exist. The APIs themselves were removed in prior releases; these negative
checks no longer guard a live migration boundary.

Also delete `scripts/probe-cache-stable-response-shape.mts`, a one-off
investigation script not referenced by any npm script or test.

No API or behavior change.

## @minpeter/pss-runtime@0.3.0-next.2 (next)

### Preserve compaction provenance until provider rendering

Expose compacted history to `model.context` as typed `role: "compaction"`
messages with their summary and source sequence range. Lower retained
compactions to user-scoped `<summary>` messages only at the provider boundary,
so model-generated summaries are not promoted to system instructions and
plugins can remove contaminated compactions without rewriting stored history.

### Add cache-aware model-step preparation

Add a PSS-owned, zero-based `prepareModelStep` callback with a logical index
that is reused across overflow and pre-commit retries, then advances from
committed history after durable resume. Support AI SDK 7 `toolOrder`, fixed
`alwaysActiveTools` prefixes, and deterministic dynamic suffixes. Preserve
factory-plugin middleware when the callback overrides the model, and fail
closed on duplicate, unknown, overlapping, or inactive tool selections,
malformed model overrides, and invalid tool-choice values. Snapshot configured
and callback-returned tool-name arrays through bounded own data descriptors
without invoking custom iterators or index getters.

Emit opt-in metadata-only name and semantic cache fingerprints through host
diagnostics. The diagnostic contains bounded counts, hashes, duration, an
attempt ID, and the logical step index, never raw prompts, tool inputs, tool
definitions, or thread keys. Automatic-compaction summary calls remain outside
model-step selection.

Add a source-hashed OpenAI-compatible live-provider benchmark for stable order,
active-set reduction, and an equal-byte membership swap. Seeded alternating
AB/BA trials derive namespaces and inert canaries from first/second execution
slots, not variant identity, so control and changed arms are counterbalanced
across cache-affinity slots. Audit response model, output compliance, input
parity, cache-read/cache-write telemetry, sanitized backend-metadata drift, and
warmup prerequisites independently. Require a sanitized `finish_reason=stop`
and exact trimmed `OK` from exactly one choice, fail closed on unsafe
token-aggregate overflow, and bound/cancel oversized JSON responses at 1 MB for
Chat Completions and 5 MB for `/models`. Retain provider HTTP failures only as
status-derived codes so reflected
credentials cannot reach artifacts or logs. Record response-ID duplicate and
cross-request-body reuse counts.

Treat provider-reported raw cache-read tokens and cache-read/input coverage
ratio as parallel descriptive endpoints. Require all four pairs in every AB/BA
model stratum, derive ratio pair and median signs with exact `BigInt` rational
arithmetic, and make any endpoint disagreement indeterminate; opposing
directions are explicitly denominator-sensitive. Neither endpoint is a causal
saving or cost estimate, and same-set/membership conclusions remain descriptive
without exact input parity. Track separate read/write ratio-eligible counts and
coverage, require every model-level conclusion to agree before publishing a
pooled direction, and reserve input-token parity for full exact equality rather
than cancelling median-zero differences.

The evidence source manifest includes root and runtime TypeScript, build,
task-runner, and formatter configurations. An evidence campaign refuses a dirty
worktree, fixes the output path, and before authenticated provider preflight
byte- and hash-compares every current manifested source with its source-freeze
Git tree blob. It records the freeze SHA plus clean-at-start status and rechecks
HEAD around source snapshots and atomic output. Keep all-sample descriptive
views, but gate `primaryComparisons` and primary membership input parity on one
matched non-null `system_fingerprint` and `service_tier` across both arms'
warmups and measurements. Any campaign-global repeated response ID, including a
same-body replay, also excludes the affected primary pair; cross-body reuse is
audited separately. The checked-in result and dated benchmark README findings
are authoritative only when schema, campaign topology, and source-hash
verification pass; no raw response content, provider payload, or credential is
retained.

Keep the generic eager selector distinct from provider-native loading. Official
AI SDK OpenAI Responses and Anthropic adapters expose their own native tool
search/defer lowering, while `@ai-sdk/openai-compatible` and the eager
FreeRouter Chat Completions benchmark make no such preservation guarantee. Pi's
Kimi work is a direct-provider-only system-message compatibility mode, not a
router capability. Gate any native follow-up by adapter, provider, model, and
version; verify it with a wire canary and fall back to eager selection when the
tuple is unknown or the canary fails.
The canary must pin and inspect an explicit approval policy because the OpenAI
API and current AI SDK OpenAI adapter have different omitted-value behavior.
Treat cache-write telemetry as a separate required signal for GPT-5.6+
economics; the generic compatible adapter does not normalize that field.
For Anthropic, reject a deferred tool that also carries `cache_control`, keep
the complete tools array stable across continuation, and canary the documented
server/custom search-result replay shapes before enabling native loading.

### Trace model usage and cache telemetry

Emit one metadata-only `model-usage` event for every successful model
invocation in the public agent loop. Expose the same normalized record through
the factory-plugin `model.usage` hook and durable thread event replay.

Aggregate prompt-cache telemetry at run, eval-case, and report scope. Add
`cacheHitRateAtLeast()` with warmup, minimum-sample, and attempted-request
coverage gates, and fail cache assertions closed when required telemetry is
missing or incomplete.

### Expose AgentTurn test helpers via the `./testing` subpath

`@minpeter/pss-runtime/testing` is now a public subpath for downstream tests
that consume `AgentTurn.events()`:

- `createMockAgentTurn(events)` builds an `AgentTurn` from an `AgentEvent`
  array or an `AsyncIterable<AgentEvent>`. Like a real turn, `events()` is
  single-consumption and throws on a second call.
- `agentEventStream(events)` replays an event array as a deterministic async
  iterable.
- `agentEvent` provides typed builders for public event payloads:
  `assistantOutput`, `assistantReasoning`, `toolCall`, `toolResult`,
  `stepStart` / `stepEnd`, the `turn-*` lifecycle events, and `userText` /
  `userMessage`.

Internal fixtures stay unexported; the subpath surface is only the helpers
above, so downstream mocks no longer drift when event names or turn APIs
change.

### Allow explicit tool.call.before input transforms

`tool.call.before` handlers may return
`{ action: "transform", input }` to replace the arguments passed to tool
`execute`. Transforms chain in plugin registration order. Each handler still
receives a structured clone of the current event, so in-place mutation of the
event object does not affect later plugins or execution.

`continue`, `block`, and `needs-recovery` decisions are unchanged. A transform
missing `input`, or an input that is not structured-cloneable, fails closed
with `PluginHookError`.

## @minpeter/pss-runtime@0.3.0-next.1 (next)

### Remove Cloudflare host and `PSS_SESSION_*` aliases

Drop `createCloudflareAgentsHost`, `CloudflareHostAgentsOptions`, and
`CloudflareAgentsHostOptions`. Use `createCloudflareHost` /
`CloudflareHostOptions` only.

Coding-agent env falls back only on `PSS_THREAD_DIR` / `PSS_THREAD_KEY`;
`PSS_SESSION_DIR` / `PSS_SESSION_KEY` are no longer accepted.

### Remove the legacy object-style plugin pipeline

Drop dual dispatch for object plugins (`AgentPlugin` / `{ on(context) }` /
`runPluginsForEvent`). Plugin behavior now runs only through factory-style
`definePlugin` handlers on `PluginRuntime`.

`createAgent({ plugins })` remains the supported registration path.
`new Agent(...)` no longer accepts a `plugins` option; use `createAgent` so
plugin factories initialize before the agent is returned.

Migrate any remaining object plugins to:

```ts
definePlugin((pss) => {
  pss.on("input.accept", handler);
});
```

### Remove orphan `@deprecated` comments

Delete leftover deprecation comments after `SessionInput` and `FileSessionStore`
aliases were already removed. No API or behavior change.

### Drop legacy storage and namespace read-compat

Stop hydrating SQLite `legacy-json` thread-message chunk markers and stop
treating `:session:` owner namespaces as valid for ownership/resume.

Current chunk markers and `:thread:` owner namespaces only.

### Shrink leftover read-compat defaults

Stop inventing session-index `thread_key` values from channel identity when
stored keys are missing, and stop granting resume access to owner-less runs
based only on a `parent:${owner}:` thread-key prefix.

Resume requires a present `ownerNamespace` accepted by `ownsAgentNamespace`.
Session-index write paths already pass explicit `threadKey` values.
`canRead` / list / search share the same rule: missing `threadKey` is not readable.

## @minpeter/pss-runtime@0.3.0-next.0 (next)

### Add cache-aware model-step preparation

Add a PSS-owned, zero-based `prepareModelStep` callback that persists logical
step indices across outer-loop overflow retries and durable resume. Support AI
SDK 7 `toolOrder`, fixed always-active prefixes, deterministic dynamic suffixes,
and fail-closed tool/model/choice validation. Remove inactive definitions from
the AI SDK executable registry, not only provider serialization. Export
metadata-only name and scoped semantic cache fingerprints, per-attempt IDs, and
selector duration without prompts, tool inputs, definitions, or thread keys.
Reject unknown callback-result fields, validate the thread key before attachment
or context-gate work, require concrete AI SDK model-object overrides, snapshot
callback-held selections through data descriptors, structured-clone history,
snapshot configured tool-name arrays without invoking custom iterators or index
getters, and expose only recursively frozen inert tool metadata facades to
selectors.
Semantic diagnostics count
dynamic descriptions and individual tool definitions that could not be
fingerprinted instead of dropping the entire record.
Upgrade AI SDK 7.0.16 to 7.0.30 for own-property tool-name hardening and the
public tool fingerprint API. Automatic-compaction summary calls remain outside
model-step selection.

### Trace model-request prompt cache usage

Emit normalized, metadata-only `model-usage` events for successful agent-loop
model attempts, including an opaque per-runtime-step `attemptId`, the provider's
response model, finish metadata, response latency, and provider-reported
reasoning and prompt-cache token counts. Usage enters live and durable event
streams before `model.usage` observers run, so a failing observer cannot erase
already billed telemetry. Hosts with durable thread-event replay flush through
the usage record immediately rather than waiting for the terminal state commit.
Eval runs now retain
per-attempt cache traces, preserve unreported-versus-zero counts, aggregate
cache statistics at turn, case, and report levels, reject malformed pairs and
unsafe aggregate overflow, and expose `cacheHitRateAtLeast()` with warmup,
minimum sample, and minimum telemetry-coverage gates. Internal
automatic-compaction summary requests remain outside the public turn event
stream. Add a reproducible live-provider eval script and sanitized evidence
snapshots that distinguish raw unreported cache fields from explicit zeroes,
document the OpenAI-compatible adapter's omitted-field normalization boundary,
and record long-context cache, exact-token recall, latency, and uncached-token
tradeoffs.

### Introduce a factory-based plugin runtime

Replace object plugins with an async factory registration kernel built around
`definePlugin`, typed `on` events, and extensible `provide` capabilities. Add
sequential async factory initialization, fail-closed hooks, subscriptions,
thread-scoped state, and index-based host diagnostics. Use `model.context` for
ephemeral model-input guards and add an atomic `model.step.before` transform
before generated messages enter history or emit mapped output events.
Dispatch the declared thread, turn, step, message, provider, compaction, and tool
lifecycle hooks at their runtime boundaries, including model-context hooks for
automatic-compaction requests. Apply typed request decisions for input
handling, transforms, compaction cancellation, tool blocking, and manual tool
recovery, and reject malformed runtime decisions with `PluginHookError`.
Plugin hook names use lowercase dotted paths, including
`provider.request.before`, `provider.response.after`,
`model.step.before`, `thread.compaction.before`, `thread.compaction.after`,
`tool.call.before`, and `turn.start.before`.

Keep thread-state shape validation inside the runtime and leave persisted
history repair to a separate version-checked recovery job with an auditable
before/after object diff.

Replace the root `Agent` constructor and `Agent.create()` surface with the async
`createAgent()` factory. `Agent` remains available as a type, while all plugin
factories finish initialization before `createAgent()` resolves.

Flatten event-backed plugin hook payloads so handlers receive their narrowed
event directly, and expose `registerTool()` as the tool capability helper.

# @minpeter/pss-runtime

## 0.2.0

### Minor Changes

- 496e522: Compress image file inputs over 1MB (default, all hosts) during attachment staging before they are written to `HostAttachmentStore`.
- d8e36b7: Collapse host types to a single `AgentHost` with `HostStore`, `HostScheduler`, and optional `HostAttachmentStore`; rename platform factories; make Cloudflare product path Agents-only; and compress image attachments to at most 1MB by default on all hosts before storage.

### Patch Changes

- 7c4bb7e: Lower the default image attachment storage budget from 1MB to 240KB so multi-image turns stay lighter while typical chat photos remain under budget.

## 0.1.3

### Patch Changes

- 02c4e2a: Add durable thread event replay via `thread.events({ after, limit })`, pre-provider context budget gating for automatic compaction, and documentation for durable attachment replay behavior.

  Align public multimodal input with AI SDK 7 by removing the deprecated `UserMessageImagePart` / `{ type: "image" }` path. Use `{ type: "file", mediaType: "image" | "image/png", data }` for image inputs.

## 0.1.2

### Patch Changes

- 4592e28: Add a durable `ThreadInputInbox` execution-store port with memory, file, and Cloudflare storage implementations, and wire runtime send/steer admission through durable input claim, promote, ack, release, recovery, and context-overflow compaction boundaries.
- cfb2a0f: Tighten runtime attachment ref validation, cleanup staged attachments on rejected durable inputs, and keep host-owned attachment stores authoritative for resumed work.
- d84ebb3: Add runtime-owned attachment staging, durable attachment refs, and provider-time hydration for multimodal file inputs.

## 0.1.1

### Patch Changes

- 8c0f020: Add a Cloudflare Agents platform adapter that maps PSS runtime scheduling onto Agents SDK fibers, delayed schedules, and fiber recovery hooks.
- 357a6bb: Align scheduled-work semantics across platform adapters: shared work-id derivation, thread-prompt validation, and list limits now live in one platform-neutral module consumed by the memory, file, and cloudflare adapters. The in-memory scheduler now honors `runAfterMs`, dedupes runs and thread prompts like the durable adapters, and exposes `listScheduledRuns` / `listScheduledThreadPrompts` / ack APIs. A new ExecutionScheduler contract test suite runs against all three platforms.

## 0.1.0

### Minor Changes

- 7346750: Add plugin-only `before-tool-call` interception so policies can request manual recovery before tool execution.

### Patch Changes

- e989f88: Add the `host` execution contract for resumable runs, durable notification
  resume, and background run capability detection. Advanced execution host, store,
  and scheduler contracts are available from `@minpeter/pss-runtime/execution`, and
  runtime-originated work can resume through `Agent.resume(runId)`.

  Background runs are now more durable: hosts can advertise background support,
  child runs are linked for cleanup/cancellation, killed sessions stop before
  cleanup waits, and stale cancelled sibling notifications are filtered without
  dropping completed work. The Cloudflare edge example shows one adapter
  implementation for Worker/Durable Object scheduling and resume.

- 5cc6285: Clean up the runtime public surface and tighten host/resume contracts.

  - Remove unused internal helpers: `runEventPlugins`, `attachRuntimeInputMeta`,
    `stripEventMeta`, and `withSteeringPlacement`. Keep the package-root
    `runPluginsForEvent` helper for compatibility with plugin test utilities.
  - Remove `AgentPlugin.events.on` (deprecated observe-only shim). Use the
    top-level `on` handler; intercept returns (`continue` / `transform` /
    `handled`) now apply to all plugins uniformly.
  - Drop `AgentSession.currentTurnId()`, `enqueueRuntimeInput()`,
    `emitObserverEvent()`, and the private `#enqueuePendingRuntimeInput()` helper;
    they were unused or test-only public-ish hooks. Observer-event behavior is now
    covered through `SessionEventDispatcher` tests.
  - Collapse `AgentLanguageModelOptions`, `AgentConstructionOptions`, and
    `AgentOptions` into a single `AgentOptions` interface.
  - Remove the empty `AgentHostCapabilities` type and replace duck-typed host
    detection with a discriminated host union (`kind: "session" | "execution" |
"durable-background"`). Session-only hosts now pass
    `host: { kind: "session", sessionStore }`.
  - `Agent.resume(runId)` no longer throws when the host cannot resume; it
    returns `null`. Add `Agent.supportsResume` to check durable-resume support
    before calling. Document that a `SessionHost` disables the in-memory
    `ExecutionHost`, so run records, tool checkpoints, and `resume()` are
    unavailable.
  - Add a `@minpeter/pss-runtime/namespace` subpath with stable namespace helpers
    (`parentSessionNamespace`, `defaultChildSessionKey`, `agentNamespace`,
    `namespacePart`, `randomAgentNamespace`) so app-owned delegation examples no
    longer copy local namespace formatting helpers.
  - Move platform adapters to domain-first public subpaths:
    `@minpeter/pss-runtime/platform/cloudflare`,
    `@minpeter/pss-runtime/platform/file`, and
    `@minpeter/pss-runtime/platform/memory`.
  - Remove the legacy `@minpeter/pss-runtime/thread-store/file` subpath; import
    `FileThreadStore` from `@minpeter/pss-runtime/platform/file`.
  - Remove Cloudflare Durable Object non-SQLite store fallbacks and legacy session
    migration; `createCloudflareDurableObjectHost` now requires `storage.sql` and
    wires SQLite event/checkpoint/session stores directly. The exported
    `InMemoryCloudflareDurableObjectStorage` remains constructible without
    arguments for test suites and supplies an in-memory SQLite-compatible backing
    store by default.
  - Remove no-op internal plumbing: the always-true observer-event filter in the
    agent loop and the unused `BufferedAgentRun.close()` reason parameter.

- 4a2ab2b: Expose a Cloudflare notification idempotency helper so Durable Object alarm handlers can recover product-level source keys from runtime-scoped scheduled prompts.
- d1c015c: Add Cloudflare notification dispatch helpers and context-aware alarm draining for multi-user Durable Object runtimes.
- 74dc8de: Fix Cloudflare notification dispatch dedupe scope, active notification observer
  events, and stale or budgeted alarm retry handling.
- 320c01c: Add a Node platform adapter with file-backed thread and execution hosts, including resumable run storage, notification inbox persistence, checkpoints, events, and local scheduled-work files. Also move Cloudflare internals under `src/platform/cloudflare` and publish platform adapters under `@minpeter/pss-runtime/platform/*`.
- 617b9f9: Refresh dependencies across the v0.1 workspace, including AI SDK 7 latest.
- b03d3ac: Normalize AI SDK fallback tool-call ids such as `delegate_to_researcher_0` to
  stable `call_*` ids so tool results, tool execution checkpoints, and session
  mapping stay consistent across model snapshots.
- 836a1c4: Rework `./evals` into an eve-parity, record-based evaluation engine.

  Evals drive a real `Agent` thread and drain its event stream — no separate eval
  universe, no new runtime dependency. The assertion model now records results
  rather than throwing on the first failure, so a single run reports every failing
  assertion (eve-style multi-verdict).

  New assertion surface on the per-case scope `t`:

  - run-level: `calledTool(name, { input, output, times })`,
    `notCalledTool`, `toolOrder`, `usedNoTools`, `maxToolCalls`,
    `messageIncludes`, `completed`, `didNotFail`, `noFailedActions`, `event`,
    `outputEquals`, `outputMatches`
  - value assertions via `t.check(value, builder)` with `includes`, `equals`,
    `matches` (Standard Schema / Zod), `similarity` (Levenshtein)
  - severity on every assertion: `.gate()` (hard, default), `.soft()`,
    `.atLeast(threshold)` (tracked, fatal only under `--strict`)

  Tool matchers accept literal (partial-deep), RegExp, or predicate. The runner
  computes a gate-based verdict, tracks soft misses ("scored"), and the `pss-eval`
  CLI gains `--strict` (soft-threshold misses also fail).

  LLM judge (`t.judge.autoevals.closedQA / factuality / summarizes`): the only
  model-backed assertions, soft by default, graded via a resolved judge model
  (`judge: { model }` per-eval or per-call `{ model }`), never the agent under
  test. Judge assertions are declared synchronously during the test and resolved
  by the runner after the test function runs, so `.atLeast`/`.gate` chain without
  `await`. Calling `t.judge.*` with no judge model records a failed gate.

  This is a breaking change to the eval authoring API: cases now receive a
  recording scope (`t`) instead of `{ run }` + a throw-based `expect`. Multi-turn
  cases accumulate state across `t.run()` calls.

- 1f3a46c: Remove the public runtime LLM function adapter surface. Agent model execution now accepts AI SDK LanguageModel objects directly, and runtime tests use AI SDK MockLanguageModelV4 fixtures.
- 41736e7: Add opt-in automatic Thread compaction for long-running agents.

  - Add `AgentOptions.autoCompaction` with validated `minMessages` and
    `retainMessages` thresholds.
  - Persist compaction summaries as `pss_thread_compaction` rows while keeping the
    full durable Thread log intact.
  - Schedule compaction after successful user-input turns without blocking turn
    completion.

- b21c318: Split durable/background host capabilities into smaller execution subpath contracts and publish a Cloudflare Durable Object adapter from `@minpeter/pss-runtime/platform/cloudflare`.
- fedd6be: Add `inspectNodeFileThread` and `nodeFileThreadStorageFile` to the Node platform
  adapter for runtime-owned local thread storage inspection.
- b03d3ac: Implement constructor-level `plugins: [...]` event observers and input intercept
  middleware.
- 0ffe9e7: Add plugin-first session persistence, memory, and event-first runtime control.

  - Keep `run.events()` as the app-owned runtime control loop for synchronized rendering, tracing, and continuation policy.
  - Add constructor-level `plugins: [...]` support with a single `on(context)` handler per plugin.
  - `on` is observe-only for most events. Three input event types (`user-text`, `user-message`, `runtime-input`) support intercept returns: `{ action: "continue" }`, `{ action: "transform", event }`, or `{ action: "handled" }`.
  - Plugins run in registration order; transforms chain so each plugin sees the previous plugin's event.
  - Route plugin logic on `event.meta?.source` (`send`, `steer`, `notify`, `delegate`). Meta is stripped before session history persistence and model mapping, so it never reaches the LLM prompt.
  - Use `host: { kind: "session", sessionStore }` for session-only persistence, `run.events()` plus `session.steer()` for app control, or constructor `plugins: [...]` for reusable middleware.

- 515b089: Fix the runtime README to document the exported `thread-store/file` subpath without referencing the removed `session-store/file` path.
- c8bf377: Support scheduled work payload LIKE deletes in the local Durable Object SQL test adapter.
- a5418f0: Support secondary-index scheduled work deletes in the local Durable Object SQL test adapter.
- ae58a13: Store Cloudflare Durable Object notification records in SQLite rows with legacy KV read-through, and make runtime checkpoint ids include run, version, and phase metadata.
- f3c4461: Harden Cloudflare Durable Object storage for production agent threads.

  - Make `RunStore.create()` insert-only and return typed duplicate results so
    notification idempotency races do not overwrite canonical runs.
  - Stop retrying scheduled non-notification runs forever when the runtime cannot
    resume them.
  - Store lower-level resume checkpoints as bounded thread references instead of
    full history snapshots.
  - Normalize scheduled work rows with `thread_key` and `run_id` indexes for
    exact cleanup.
  - Add append-delta writes and chunked oversized thread-message payloads for the
    SQLite thread store.

- d1e0186: Add a local Cloudflare Durable Object storage stress harness, including an opt-in 200MB-scale extreme profile, and expose host-level payload budget configuration.
- ae8de0e: Replace the async Agent factory with direct construction and keep delegation
  app-owned through ordinary tools, sessions, and host-owned background runs.
  Runtime-owned subagent APIs and built-in delegation tools are not shipped; see
  the sync and background example packages for blocking and background
  delegation patterns.
- 641ccbf: Rename execution, Cloudflare scheduling, and notification APIs from
  `sessionKey`/`resumeSession`/scheduled session prompts to
  `threadKey`/`resumeThread`/scheduled thread prompts. Thread keys are now the
  public app-facing address for linear conversation history, while existing
  storage-session internals remain opaque behind the runtime host boundary.
- 8c3e696: Replace legacy session/run public aliases with Thread, Turn, and Checkpoint runtime naming.
- 307f8fd: Unify user-originated thread events as `user-input` and simplify public thread
  input to plain text, text arrays, or content-part arrays. Object-shaped
  `user-text` and `user-message` inputs are no longer part of the public
  `send()`/`steer()` surface; notification/resume internals still persist a typed
  `user-input` payload.

  Add noncanonical `thread.overlay(input)` for next-turn runtime context.
  Overlays accept the same input shapes as `send()`, are chainable, and enter the
  next turn as `runtime-input` before the user message rather than as another
  human `user-input` event. Overlay context is visible to the current model turn
  but is excluded from stored thread history and automatic compaction summaries.

  Add notification resume overlays so durable notification turns can inject fresh
  per-run context without baking that context into the canonical thread log.

- 0a1f556: Add `DurableObjectSqliteEventStore` and `DurableObjectSqliteCheckpointStore`,
  the append-only SQLite stores used by the Cloudflare Durable Object host.

  Like `DurableObjectSqliteSessionStore`, they persist one small SQLite row per
  event / per checkpoint instead of re-writing a whole per-run list into a single
  `storage.put` value on every append. A run with many large tool-result events or
  full-history checkpoints can no longer cross the Durable Object ~2MB per-value
  limit (`SQLITE_TOOBIG`) by accumulation — the failure that surfaced as
  `Error: string or blob too big: SQLITE_TOOBIG` on the `afterTool` checkpoint
  write after tools such as `web_search`.

  `createCloudflareDurableObjectHost` now requires SQLite-backed Durable Object
  storage (`storage.sql`) and wires these SQLite stores directly. Event cursors
  (1-based skip offsets), checkpoint `stale-version` optimistic checks, and
  `latest()` semantics are preserved. Both stores are re-exported from
  `@minpeter/pss-runtime/platform/cloudflare`.

- b687931: Add `DurableObjectSqliteSessionStore`, an append-only session store for
  SQLite-backed Durable Objects, and make the Cloudflare Durable Object host use it
  by default. It persists conversation history as one small SQLite row per message
  (delta-append on commit, reconstruct on load) instead of re-serializing the
  entire snapshot into a single `storage.put` value every turn, so long sessions no
  longer cross the Durable Object ~2MB per-value limit (`SQLITE_TOOBIG`).
  Rollbacks soft-delete trailing rows and optimistic version/conflict semantics are
  preserved.

  `createCloudflareDurableObjectHost` now requires SQLite-backed Durable Object
  storage (`storage.sql`). Callers can still pass `sessionStore` when they need to
  provide a custom session store.

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

- a58c756: Rename Cloudflare SQLite thread history tables from `pss_session_*` to `pss_thread_*` with legacy row migration, and store run records in SQLite rows instead of Durable Object KV values.
- 11dd14d: Expose per-run eval traces in case reports so multi-turn evals can inspect each input, event stream, tool call, and visible output.

## 0.1.0-next.24

### Minor Changes

- 7346750: Add plugin-only `before-tool-call` interception so policies can request manual recovery before tool execution.

### Patch Changes

- 617b9f9: Refresh dependencies across the v0.1 workspace, including AI SDK 7 latest.
- 11dd14d: Expose per-run eval traces in case reports so multi-turn evals can inspect each input, event stream, tool call, and visible output.

## 0.1.0-next.23

### Patch Changes

- 836a1c4: Rework `./evals` into an eve-parity, record-based evaluation engine.

  Evals drive a real `Agent` thread and drain its event stream — no separate eval
  universe, no new runtime dependency. The assertion model now records results
  rather than throwing on the first failure, so a single run reports every failing
  assertion (eve-style multi-verdict).

  New assertion surface on the per-case scope `t`:

  - run-level: `calledTool(name, { input, output, times })`,
    `notCalledTool`, `toolOrder`, `usedNoTools`, `maxToolCalls`,
    `messageIncludes`, `completed`, `didNotFail`, `noFailedActions`, `event`,
    `outputEquals`, `outputMatches`
  - value assertions via `t.check(value, builder)` with `includes`, `equals`,
    `matches` (Standard Schema / Zod), `similarity` (Levenshtein)
  - severity on every assertion: `.gate()` (hard, default), `.soft()`,
    `.atLeast(threshold)` (tracked, fatal only under `--strict`)

  Tool matchers accept literal (partial-deep), RegExp, or predicate. The runner
  computes a gate-based verdict, tracks soft misses ("scored"), and the `pss-eval`
  CLI gains `--strict` (soft-threshold misses also fail).

  LLM judge (`t.judge.autoevals.closedQA / factuality / summarizes`): the only
  model-backed assertions, soft by default, graded via a resolved judge model
  (`judge: { model }` per-eval or per-call `{ model }`), never the agent under
  test. Judge assertions are declared synchronously during the test and resolved
  by the runner after the test function runs, so `.atLeast`/`.gate` chain without
  `await`. Calling `t.judge.*` with no judge model records a failed gate.

  This is a breaking change to the eval authoring API: cases now receive a
  recording scope (`t`) instead of `{ run }` + a throw-based `expect`. Multi-turn
  cases accumulate state across `t.run()` calls.

- fedd6be: Add `inspectNodeFileThread` and `nodeFileThreadStorageFile` to the Node platform
  adapter for runtime-owned local thread storage inspection.

## 0.1.0-next.22

### Patch Changes

- Rename visible assistant response events from `assistant-text` to `assistant-output`.
  The new name better matches the thread model where user messages are inputs and
  assistant messages are model outputs appended back into the thread.

## 0.1.0-next.21

### Patch Changes

- Unify user-originated thread events as `user-input` and simplify public thread
  input to plain text, text arrays, or content-part arrays. Object-shaped
  `user-text` and `user-message` inputs are no longer part of the public
  `send()`/`steer()` surface; notification/resume internals still persist a typed
  `user-input` payload.

  Add noncanonical `thread.overlay(input)` for next-turn runtime context.
  Overlays accept the same input shapes as `send()`, are chainable, and enter the
  next turn as `runtime-input` before the user message rather than as another
  human `user-input` event. Overlay context is visible to the current model turn
  but is excluded from stored thread history and automatic compaction summaries.

  Add notification resume overlays so durable notification turns can inject fresh
  per-run context without baking that context into the canonical thread log.

## 0.1.0-next.20

### Patch Changes

- 41736e7: Add opt-in automatic Thread compaction for long-running agents.

  - Add `AgentOptions.autoCompaction` with validated `minMessages` and
    `retainMessages` thresholds.
  - Persist compaction summaries as `pss_thread_compaction` rows while keeping the
    full durable Thread log intact.
  - Schedule compaction after successful user-input turns without blocking turn
    completion.

## 0.1.0-next.19

### Patch Changes

- 515b089: Fix the runtime README to document the exported `thread-store/file` subpath without referencing the removed `session-store/file` path.

## 0.1.0-next.18

### Patch Changes

- 320c01c: Add a Node platform adapter with file-backed thread and execution hosts, including resumable run storage, notification inbox persistence, checkpoints, events, and local scheduled-work files. Also move Cloudflare internals under `src/platform/cloudflare` while keeping the public Cloudflare subpath stable.
- 8c3e696: Replace legacy session/run public aliases with Thread, Turn, and Checkpoint runtime naming.

## 0.1.0-next.17

### Patch Changes

- c8bf377: Support scheduled work payload LIKE deletes in the local Durable Object SQL test adapter.

## 0.1.0-next.16

### Patch Changes

- a5418f0: Support secondary-index scheduled work deletes in the local Durable Object SQL test adapter.

## 0.1.0-next.15

### Patch Changes

- d1e0186: Add a local Cloudflare Durable Object storage stress harness, including an opt-in 200MB-scale extreme profile, and expose host-level payload budget configuration.

## 0.1.0-next.14

### Patch Changes

- f3c4461: Harden Cloudflare Durable Object storage for production agent threads.

  - Make `RunStore.create()` insert-only and return typed duplicate results so
    notification idempotency races do not overwrite canonical runs.
  - Stop retrying scheduled non-notification runs forever when the runtime cannot
    resume them.
  - Store lower-level resume checkpoints as bounded thread references instead of
    full history snapshots.
  - Normalize scheduled work rows with `thread_key` and `run_id` indexes for
    exact cleanup.
  - Add append-delta writes and chunked oversized thread-message payloads for the
    SQLite thread store.

## 0.1.0-next.13

### Patch Changes

- ae58a13: Store Cloudflare Durable Object notification records in SQLite rows with legacy KV read-through, and make runtime checkpoint ids include run, version, and phase metadata.

## 0.1.0-next.12

### Patch Changes

- a58c756: Rename Cloudflare SQLite thread history tables from `pss_session_*` to `pss_thread_*` with legacy row migration, and store run records in SQLite rows instead of Durable Object KV values.

## 0.1.0-next.11

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

## 0.1.0-next.10

### Patch Changes

- 641ccbf: Rename execution, Cloudflare scheduling, and notification APIs from
  `sessionKey`/`resumeSession`/scheduled session prompts to
  `threadKey`/`resumeThread`/scheduled thread prompts. Thread keys are now the
  public app-facing address for linear conversation history, while existing
  storage-session internals remain opaque behind the runtime host boundary.

## 0.1.0-next.9

### Patch Changes

- 4a2ab2b: Expose a Cloudflare notification idempotency helper so Durable Object alarm handlers can recover product-level source keys from runtime-scoped scheduled prompts.
- 1dd09de: Replace the public `agent.session(key)` entrypoint with `agent.thread(key)`.
  Threads are the app-facing conversation unit; runtime session state remains an
  internal storage concern behind the thread handle. `agent.thread({ key, scope })`
  now provides an optional scoped address for multi-user integrations while
  preserving opaque session storage under the host boundary.

## 0.1.0-next.8

### Patch Changes

- 5cc6285: Clean up the runtime public surface and tighten host/resume contracts.

  - Remove unused internal helpers: `runEventPlugins`, `attachRuntimeInputMeta`,
    `stripEventMeta`, and `withSteeringPlacement`. Keep the package-root
    `runPluginsForEvent` helper for compatibility with plugin test utilities.
  - Remove `AgentPlugin.events.on` (deprecated observe-only shim). Use the
    top-level `on` handler; intercept returns (`continue` / `transform` /
    `handled`) now apply to all plugins uniformly.
  - Drop `AgentSession.currentTurnId()`, `enqueueRuntimeInput()`,
    `emitObserverEvent()`, and the private `#enqueuePendingRuntimeInput()` helper;
    they were unused or test-only public-ish hooks. Observer-event behavior is now
    covered through `SessionEventDispatcher` tests.
  - Collapse `AgentLanguageModelOptions`, `AgentConstructionOptions`, and
    `AgentOptions` into a single `AgentOptions` interface.
  - Remove the empty `AgentHostCapabilities` type and replace duck-typed host
    detection with a discriminated host union (`kind: "session" | "execution" |
"durable-background"`). Session-only hosts now pass
    `host: { kind: "session", sessionStore }`.
  - `Agent.resume(runId)` no longer throws when the host cannot resume; it
    returns `null`. Add `Agent.supportsResume` to check durable-resume support
    before calling. Document that a `SessionHost` disables the in-memory
    `ExecutionHost`, so run records, tool checkpoints, and `resume()` are
    unavailable.
  - Add a `@minpeter/pss-runtime/namespace` subpath with stable namespace helpers
    (`parentSessionNamespace`, `defaultChildSessionKey`, `agentNamespace`,
    `namespacePart`, `randomAgentNamespace`) so app-owned delegation examples no
    longer copy local namespace formatting helpers.
  - Remove Cloudflare Durable Object non-SQLite store fallbacks and legacy session
    migration; `createCloudflareDurableObjectHost` now requires `storage.sql` and
    wires SQLite event/checkpoint/session stores directly. The exported
    `InMemoryCloudflareDurableObjectStorage` remains constructible without
    arguments for test suites and supplies an in-memory SQLite-compatible backing
    store by default.
  - Remove no-op internal plumbing: the always-true observer-event filter in the
    agent loop and the unused `BufferedAgentRun.close()` reason parameter.

- d1c015c: Add Cloudflare notification dispatch helpers and context-aware alarm draining for multi-user Durable Object runtimes.
- 74dc8de: Fix Cloudflare notification dispatch dedupe scope, active notification observer
  events, and stale or budgeted alarm retry handling.

## 0.1.0-next.7

### Patch Changes

- 0a1f556: Add `DurableObjectSqliteEventStore` and `DurableObjectSqliteCheckpointStore`,
  the append-only SQLite counterparts to the legacy KV event/checkpoint stores.

  Like `DurableObjectSqliteSessionStore`, they persist one small SQLite row per
  event / per checkpoint instead of re-writing the whole per-run list into a
  single `storage.put` value on every append. A run with many large tool-result
  events or full-history checkpoints can no longer cross the Durable Object ~2MB
  per-value limit (`SQLITE_TOOBIG`) by accumulation — the failure that surfaced as
  `Error: string or blob too big: SQLITE_TOOBIG` on the `afterTool` checkpoint
  write after tools such as `web_search`.

  `createCloudflareDurableObjectHost` now selects these SQLite stores
  automatically when `storage.sql` is available (ChatRoom-style SQLite-backed
  Durable Objects), and keeps the legacy KV stores on non-SQLite storage, so no
  caller change is required. Event cursors (1-based skip offsets), checkpoint
  `stale-version` optimistic checks, and `latest()` semantics are preserved
  byte-for-byte. Both new stores are re-exported from
  `@minpeter/pss-runtime/cloudflare`.

## 0.1.0-next.6

### Patch Changes

- Sync dependency updates from main into the v0.1 prerelease line.

## 0.1.0-next.5

### Patch Changes

- b687931: Add `DurableObjectSqliteSessionStore`, an append-only session store for
  SQLite-backed Durable Objects. It persists conversation history as one small
  SQLite row per message (delta-append on commit, reconstruct on load) instead of
  re-serializing the entire snapshot into a single `storage.put` value every turn,
  so long sessions no longer cross the Durable Object ~2MB per-value limit
  (`SQLITE_TOOBIG`). Rollbacks soft-delete the trailing rows, the optimistic
  version/conflict semantics are preserved byte-for-byte, and any pre-existing
  `storage.put` snapshot is lazily migrated into rows on first access. Opt in via
  the existing `sessionStore` option of `createCloudflareDurableObjectHost`; the
  default store is unchanged.

## 0.1.0-next.4

### Patch Changes

- 1f3a46c: Remove the public runtime LLM function adapter surface. Agent model execution now accepts AI SDK LanguageModel objects directly, and runtime tests use AI SDK MockLanguageModelV4 fixtures.

## 0.1.0-next.3

### Patch Changes

- fc024ec: Remove the unreleased runtime-owned subagent API and implementation. Delegation now stays app-owned through ordinary tools, sessions, and host-owned background runs; see the sync and background examples for those patterns.
- b21c318: Split durable/background host capabilities into smaller execution subpath contracts and publish a Cloudflare Durable Object adapter from `@minpeter/pss-runtime/cloudflare`.

## 0.1.0-next.2

### Patch Changes

- e989f88: Add the `host` execution contract for resumable runs and durable
  notification resume. Advanced execution host, store, and scheduler contracts
  are available from `@minpeter/pss-runtime/execution`, and runtime-originated
  work can resume through `Agent.resume(runId)`.

  Durable background scheduling is host-owned: apps can persist their own run
  records and completion notifications while the runtime keeps the generic
  execution store, scheduler, and notification resume primitives.

- b03d3ac: Normalize AI SDK fallback tool-call ids such as `lookup_0` to
  `call_*` so app-owned tools can correlate model tool calls with their own
  durable work records.
- b03d3ac: Implement constructor-level `plugins: [...]` event observers and lifecycle middleware.

## 0.1.0-next.1

### Patch Changes

- ae8de0e: Replace the async Agent factory with direct construction and keep
  delegation as app-owned tool composition.

## 0.1.0-next.0

### Minor Changes

- 0ffe9e7: Add plugin-first session persistence, memory, and compaction APIs, plus event-first runtime control.

  - Keep `run.events()` as the app-owned runtime control loop for synchronized rendering, tracing, and continuation policy.
  - Expand plugin lifecycle middleware with `turn.before`, `step.before`, `step.after`, and `turn.after` handlers that can call scoped `steer(...)`.
  - Route plugin lifecycle handler failures through the returned run so callers own observability.
  - Add runtime-owned tool policy middleware with `tool.call` and `tool.result` for allow, modify, reject-and-continue, synthesize, error, and result replacement flows.
  - Use `host: { sessionStore }` for persistence, `run.events()` plus `session.steer()` for app control, or plugin lifecycle handlers for reusable middleware.

### Patch Changes

- 3761c93: Add turn-scoped session overlays with non-persistent `session.overlay(input)` runtime context, overlay lifecycle events, and plugin lifecycle overlay helpers.

## 0.0.10

### Patch Changes

- 5fc427d: Hide the internal agent loop runner from the root runtime export and clarify the session store version contract so stores own loaded-session versions while commit payloads carry state only.

  Rename the synchronized run event iterator from `run.stream()` to `run.events()` across the runtime API and examples. This intentionally removes `run.stream()`; replace calls with `run.events()`.

## 0.0.9

### Patch Changes

- 20103d2: Make the coding-agent TUI subpath import-safe, correct multimodal docs, and trim redundant runtime type exports.

## 0.0.8

### Patch Changes

- c991a6a: Replace the public current-turn input API with `session.steer(input)` and keep
  `session.send(input)` as the new-turn queue. Active TUI submissions now steer the
  current run through the session API.

## 0.0.7

### Patch Changes

- c71ea7d: Add runtime `toolChoice` configuration and lifecycle events for turns and steps.

## 0.0.6

### Patch Changes

- 37a14b9: Add serializable image/file content parts to `agent.send` and session sends, preserving them through runtime-owned session snapshots.
- 37a14b9: Document first-pass image input support in the runtime session/send API.
- 1b43c77: Keep runtime transcripts event-only while storing session continuation state as an internal versioned snapshot.

## 0.0.5

### Patch Changes

- fbe0448: Make agent sessions runtime-owned and durable through an opaque session store boundary, including memory/file stores and coding-agent TUI file-backed sessions.

## 0.0.4

### Patch Changes

- 23cce55: Accept AI SDK ToolSet directly for runtime Agent tools.

## 0.0.3

### Patch Changes

- c5b7c8b: Allow `AgentSession.submit()` user text to be passed as an array of strings for host-rendered per-turn context.

## 0.0.2

### Patch Changes

- f503ccd: Enhance `AgentSession` with state hydration, mutation tracking, and broader TypeScript type exports:

  - Add `history` hydration through `AgentSession` constructor options.
  - Introduce `getHistory()` to retrieve the current snapshot of the agent's message history.
  - Add lifecycle callbacks to `AgentSession` and model history for serialized mutation-time history snapshots.
  - Keep `kill()` from hanging active turns that are waiting on stalled history persistence.
  - Export `AgentMessage` globally from `@minpeter/pss-runtime` for clean external representation of internal AI SDK message structures.

## 0.0.1

### Patch Changes

- 8f03383: Publish the initial pss-next runtime and coding-agent packages from the new Turborepo workspace.
