# @minpeter/pss-coding-agent

Model wiring and the `pss` TUI for pss-runtime. The TUI includes
`@minpeter/opensearch`-backed `web_search` and `web_fetch` tools by default;
OpenSearch picks its search/fetch providers from the environment and falls
back to keyless engines when no provider API key is configured.

## Install

```sh
pnpm add -g @minpeter/pss-coding-agent
pss
```

Run it once without installing:

```sh
pnpm dlx @minpeter/pss-coding-agent
```

Set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` before the first run (a `.env`
next to the working directory is picked up automatically). The installed
binaries are `pss` and `pss-coding-agent`; for one headless task use `pss exec
--workspace . --prompt "..."`. See [CLI](#cli) for updates, `pss exec` flags,
and thread inspection, and [Env](#env) for the full variable list.

## Library use

```ts
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import { createAgent } from "@minpeter/pss-runtime";

const agent = await createAgent({
  model: createCodingLanguageModel(),
});

const turn = await agent.send("Hello from pss");
for await (const event of turn.events()) {
  console.dir(event, { depth: null });
}
```

`turn.events()` is synchronized and drives the turn. The runtime waits at
`turn-start`, `step-start`, and `step-end` until the events consumer continues,
so consume the events to let the turn progress. Use `thread.send(input)` for a
new user turn and `thread.steer(input)` to steer the active turn. If no turn is
active, `thread.steer(input)` starts a normal turn.

```ts
const thread = agent.thread("default");
const turn = await thread.send("Explain the latest result.");
let askedForExample = false;

for await (const event of turn.events()) {
  if (event.type === "step-end" && !askedForExample) {
    askedForExample = true;
    await thread.steer("Add one concrete example.");
  }
}
```

Guard `step-end` additions. Runtime input added at `step-end` intentionally
continues the current turn before the next model snapshot, even if the assistant
already printed final-looking text. Adding input on every `step-end` can keep
the turn running indefinitely.

Steered additions emit `runtime-input`: runtime/API-originated input mapped
internally to the model's user role, separate from human `user-input` events.

## Extensions

Published coding-agent extensions are ESM modules with a default factory.
The factory receives one API for tools, instructions, commands, TUI renderers,
runtime hooks, activation cleanup, and durable thread migrations:

```ts
import {
  command,
  defineCodingAgentExtension,
  instructions,
  modelProvider,
  threadMigration,
  toolRenderer,
  tools,
  type ExtensionAPI,
} from "@minpeter/pss-coding-agent/extension";

export default defineCodingAgentExtension(function workspacePolicy(pss: ExtensionAPI) {
  pss.provide(
    instructions("Keep all file operations in the workspace."),
  );
  pss.provide(tools({
    review_workspace: reviewWorkspaceTool,
  }));
  pss.provide(command(reviewCommand));
  pss.provide(
    toolRenderer("review_workspace", renderWorkspaceReview),
  );
  pss.provide(threadMigration({
    id: "sanitize-legacy-history",
    version: 1,
    migrate(snapshot) {
      return {
        ...snapshot,
        history: snapshot.history.filter(isSafeMessage),
      };
    },
  }));
  pss.provide(modelProvider({
    id: "acme",
    models: ["fast"],
    create: (modelId) => createAcmeModel(modelId),
  }));
  pss.use({
    beforeToolExecution(checkpoint) {
      if (checkpoint.toolName === "delete_file") {
        return {
          output: "delete_file is disabled",
          status: "blocked",
        };
      }
    },
  });
  pss.on("turn-error", (event, context) => {
    reportFailure({
      error: event.error,
      runId: context.runId,
      threadKey: context.threadKey,
    });
  });
  pss.on("activate", async ({ services }) => {
    services.logger.info("workspace policy active");
    await services.state.set({ activated: true });
    const child = await services.agents.create({
      instructions: "Review the workspace without editing it.",
      model: { provider: "acme", id: "fast" },
    });
    const watcher = startWorkspaceWatcher();
    return async () => {
      watcher.close();
      await child.dispose();
    };
  });
});
```

The factory object deliberately remains only `pss.on`, `pss.use`, and
`pss.provide`. Static contributions are capability values. Runtime facilities
are available through activation, event, and extension-command contexts:

- `services.logger` is an extension-attributed structured logger.
- `services.ui` provides notification/status plus real TUI input, select, and
  confirmation dialogs. Interactive requests reject in `pss exec`.
- `services.exec.run()` accepts an executable and argv, not a shell string. Its
  cwd must stay inside the workspace; lifecycle abort, output bounds, timeout,
  and API-key filtering are host-owned.
- `services.agents.create()` creates host-managed child agents. It uses the
  application model by default or an explicit `modelProvider()` contribution;
  providers never replace the main agent model implicitly.
- `services.config` is immutable JSON from the extension's installed settings,
  and `services.state` persists JSON atomically under an extension-ID-scoped
  host path.

The existing `toolRenderer()` capability is the renderer boundary. Extensions
cannot register arbitrary raw TUI components or persisted message/entry
renderers because those have no extension-owned runtime domain.

Extensions configure sequentially, use stable IDs, and cannot register new
contributions after the factory resolves. The old registry-object shape remains
supported for compatibility, but is deprecated and documented separately at
`@minpeter/pss-coding-agent/extension/legacy`; new extensions should use the
factory API above. Foreign capability-shaped objects remain runtime-compatible,
while the TypeScript API brands every value returned by a capability factory.
 Activation callbacks run after agent
creation; cleanups run in reverse order. `pss.use()` composes control-flow
hooks, `pss.on()` observes runtime and activation events, and overloaded
`pss.provide()` accepts branded instruction, tool, command, migration, model
provider, and renderer capabilities. Each factory's capabilities are validated
and staged before one atomic publication; unknown capability kinds fail
closed. Event handlers run serially in extension and registration order.
Naming a stream event such as `assistant-output-delta` explicitly opts into
ephemeral deltas; handler failures are attributed to the owning extension and
surfaced after the original events.

Install an extension globally or for one project:

```sh
pss extension install npm:@acme/pss-git-tools@1.2.0
pss extension install git+https://github.com/acme/pss-review.git
pss extension install ./local-package
pss extension install ./local-extension.mjs --id local-policy
pss extension install ./local-extension.mjs --scope project --id local-policy
```

Manage installed extensions:

```sh
pss extension list
pss extension disable @acme/pss-git-tools
pss extension enable @acme/pss-git-tools
pss extension update --all
pss extension remove @acme/pss-git-tools
```

Global settings and packages live under `~/.pss`; project entries live under
`<project>/.pss`. Global extensions load first, followed by trusted project
extensions. Explicit project install or enable records project trust. Disabled
or untrusted project extensions are never imported.

Loose local modules must be runnable `.js` or `.mjs` files and require
`--id`. npm, Git, and local packages use their `package.json` name as the
default stable ID and must ship runnable ESM. Dependency lifecycle scripts are
disabled during managed installation.

### Local extensions without installing

Drop loose modules into an extensions directory and they load automatically:

- `~/.pss/extensions/<name>.<ts|mts|js|mjs>` (global, every project)
- `~/.pss/extensions/<name>/index.*` (global, directory form)
- `<project>/.pss/extensions/<name>.*` (project, loads only after trust)

TypeScript files run directly through Node's native type stripping — no build
step. The file or directory name is the extension id and must match
`[a-z0-9][a-z0-9._-]*` (reserved names such as `constructor` are rejected;
declaration files like `guard.d.ts` are ignored). Symbolic links, duplicate
ids, and ids that collide with an installed extension — enabled or disabled —
are skipped with startup notices. Project-local files override global-local
files with the same id.

For one run only, pass `-e`/`--extension` (repeatable) to the TUI or exec:

```sh
pss -e ./review-guard.ts
pss exec --prompt "..." -e ./review-guard.ts -e ./metrics
```

CLI extensions load without trust gating (running them is an explicit user
action) and take precedence over configured extensions with the same id.

### Reloading extensions

In the TUI, `/reload` rebuilds the extension runtime from disk without
restarting the session: extensions are rediscovered (managed installs, local
modules, and `-e` paths), re-imported past the module cache, and activated
against a replacement agent while the durable thread keeps its history. The
previous runtime is cleaned up before the replacement activates so old
cleanup can never overwrite the replacement's extension state; if loading,
configuration, or validation fails, the current session keeps running
unchanged (including its CommonJS module cache), and if activation itself
fails, a runtime is rebuilt from the previous extensions so the session
stays usable. Reloaded thread migrations are committed for the current
thread before the swap, preserving exactly-once semantics. Reload refreshes
extension-owned files only (including a managed package's own helpers);
dependencies under `node_modules` keep their loaded versions, so updating a
dependency still requires `pss extension update` or a restart. The command
appears only when the session was started through the `pss` CLI, which can
rediscover extensions.

Before anything in the live process is touched, every reload candidate is
first imported in an isolated worker-thread module context (staging). A
candidate that throws at module scope or exports the wrong shape fails the
reload during staging, so the live runtime's module graph and CommonJS
cache stay untouched. Staging runs module side effects once in the
discarded worker context before the real import at commit time.

### Inter-extension events

`services.events` is a shared bus for extension-to-extension communication:

```ts
const unsubscribe = services.events.on("checkpoint:saved", (payload) => {
  services.logger.info("checkpoint", payload);
});
services.events.emit("checkpoint:saved", { revision: 7 });
```

Event payloads can be shared across packages with declaration merging of
`CodingAgentExtensionEventMap`; `emit` and `on` then infer the payload from the
event name. Payloads are JSON values cloned per delivery, handlers run under the
host timeout/abort boundary, and failures are attributed to the subscribing
extension without affecting the publisher. The `host:` and `provider:`
namespaces are reserved for host-originated events; extensions can subscribe
to them but cannot publish into them.

### Context resources: AGENTS.md, prompt templates, and skills

File-based context resources work without writing an extension:

- **AGENTS.md context files** — `~/.pss/AGENTS.md` plus every `AGENTS.md`
  from the repository root (the first ancestor containing `.git`) down to
  the working directory are injected into the system prompt, closest file
  last.
- **Prompt templates** — `*.md` files in `~/.pss/prompts/` (global) and
  `<project>/.pss/prompts/` (project, trust-gated) become `/name` slash
  commands in the TUI and expand `pss exec --prompt "/name args"` prompts.
  `$ARGUMENTS` receives the full argument string and `$1`–`$9` positional
  arguments; bodies without placeholders get the arguments appended. An
  optional `description:` frontmatter line labels the command. Built-in and
  extension commands always win name collisions; shadowed templates are
  skipped with a notice. Project templates beat global ones, which beat
  extension-contributed ones.
- **Skills** — `~/.pss/skills/<name>/SKILL.md` and (trust-gated)
  `<project>/.pss/skills/<name>/SKILL.md` directories with `name`/
  `description` frontmatter. Only the metadata is loaded eagerly; the
  system prompt lists each skill and the model reads the `SKILL.md` on
  demand when a task matches.
- **Extension contribution** — extensions can contribute resource
  directories with the `resources` capability:

  ```ts
  import { resources } from "@minpeter/pss-coding-agent/extension";
  pss.provide(resources({ prompts: ["/abs/prompts"], skills: ["/abs/skills"] }));
  ```

Untrusted project resources are blocked with a notice (the same trust gate
the extension loader uses), and malformed trust settings fail safe.
Context resources are discovered at session startup and re-discovered by
`/reload`, so edited templates, skills, AGENTS.md files, and freshly
contributed extension resource roots apply without a restart; a failed
reload keeps the previous resources with the previous runtime.

### Sessions

The TUI manages named, resumable, forkable sessions per working directory.
Metadata (names, fork parentage, the active session) lives in a sidecar
`sessions.json` next to the thread files:

- `/new [name]` — start a new empty session
- `/resume` — interactive picker (switch, rename, or delete a session;
  deleting the live session is blocked — switch away first);
  `/resume <key|name>` switches directly (with completions)
- `/name <name>` — name the current session (also `pss --name <name>` at
  startup)
- `/fork` — pick a branch point: the latest state or *before an earlier
  user message* (the fork keeps the truncated history and only the
  compaction records that fit it); `/fork <name>` forks at the latest
  state under that name. Applied thread migrations carry over so they
  never re-run on the fork, and the parent thread key is recorded
- `/clear` — wipe the current session in place (legacy behavior)

Session recency updates on every completed turn, so the `/resume` picker
sorts by actual use.

Extensions observe the lifecycle through host bus events
(`host:session-start` with reason `startup` | `new` | `resume` | `fork` |
`clear`, `host:session-switch`, `host:session-shutdown`) and can veto
switches and forks with the `sessionGuard` capability:

```ts
import { sessionGuard } from "@minpeter/pss-coding-agent/extension";
pss.provide(
  sessionGuard({
    beforeSwitch: ({ fromKey, toKey, reason }) =>
      hasUnsavedWork(fromKey) ? { cancel: true, reason: "unsaved work" } : undefined,
  })
);
```

Guard errors, timeouts, and malformed decisions fail closed (the change is
cancelled). See `docs/rfc/session-lifecycle.md` for the full design.

### Provider observations

The host publishes read-only provider HTTP observations on the bus:

- `provider:request` — `{ method, url }` before each model call
- `provider:response` — `{ status, url, headers }` after each response
- `provider:error` — `{ message, url }` when the request fails

URLs are stripped of credentials and query strings, request bodies and
headers are never exposed, and response headers pass a safelist
(`content-type`, `retry-after`, `x-request-id`, and rate-limit headers).

Programmatic static-object extensions remain supported through
`defineCodingAgentExtension()` and the `extensions` option on `startTui()` or
`runCodingAgentExec()`. Their existing `registry.runtime.use()` API remains an
alias of top-level `registry.use()`.

The TUI renders the runtime's streaming deltas as live tokens while a step
runs. Dedupe against the committed events is built in: committed
`assistant-output` text renders only when a step produced no deltas.

Provider failures use the runtime's structured `turn-error.error` metadata.
The TUI maps stable categories to a concise title and action, shows only the
safe summary, and renders bounded correlation IDs with their header source. It
does not parse provider prose or print raw API errors, stacks, request bodies,
response bodies, URLs, headers, or credentials. Legacy replay records without
metadata remain readable as a generic `Request failed` message without
speculative guidance.

### LaTeX display math in the TUI

LaTeX support is a built-in extension that ships inside the coding-agent
package. The coding-agent includes it by default and owns the generic
assistant-renderer capability plus the ordinary Markdown fallback; each
built-in extension owns its own parsing, rendering, caching, instructions,
and dependency notices. Bundled fallback renderers
compose into an ordered chain: each renderer handles the fragments it owns
and delegates everything else inward, and the plain Markdown view sits at the
bottom. This uses the same extension registration, conflict attribution, and
`/reload` lifecycle as third-party extensions.

Bundled LaTeX and Mermaid register as fallback assistant renderers; later
registrations delegate unhandled Markdown to earlier ones. A third-party
renderer can join the chain with `{ mode: "fallback" }` or replace it entirely
with `{ mode: "override" }`; the default `"exclusive"` mode remains a
source-attributed conflict when another renderer is already registered. The
older boolean options remain accepted for compatibility. Renderer contexts
receive an `AbortSignal`, session-scoped `notifyOnce`, a redraw callback, and
a `delegate` that renders unhandled text through the next inner renderer.
Optional view disposal runs when the transcript is cleared or the TUI stops.

On Kitty-graphics terminals (Kitty, Ghostty, WezTerm, and Warp), complete
Markdown display-math blocks are rendered as typeset images:

```markdown
$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$
```

Both `$$ ... $$` and `\[ ... \]` are supported. Short `$...$` expressions
are rendered as highlighted inline Markdown, while the coding-agent system
instructions reserve complete `$$` blocks for standalone equations, fractions,
derivations, matrices, and other non-trivial notation. Display delimiters stay
on their own lines. The renderer still accepts `\[ ... \]` for user- or
context-supplied Markdown. The prompt also requires two literal backslashes for
rows in `cases`, matrices, arrays, and aligned equations; the renderer repairs
the common single-backslash-at-end-of-row model error before invoking MathJax.
Delimiters inside inline, fenced, or indented code remain plain Markdown.

Rendering runs bundled MathJax and resvg WebAssembly in a persistent Node
worker to produce a transparent PNG. Script-specific bundled Noto fonts cover
Latin, locale-correct Japanese, Korean, Simplified and Traditional Chinese,
Arabic, Hebrew, Devanagari, and Thai text; no browser, system font, system
package, or executable is required. It retains a high-resolution PNG while
using smaller logical display dimensions, so Kitty downsamples instead of
upscaling a low-resolution source. Placeholder columns are derived from the
PNG aspect ratio and the terminal's measured cell width/height rather than
rounding width and height independently, which avoids horizontally compressed
formulas.
Every display formula also gets one terminal blank row above and below,
matching Codex's visual spacing. The final PNG is
cached under
`$XDG_CACHE_HOME/pss/latex` (normally `~/.cache/pss/latex`) and placed with
Kitty Unicode-placeholder cells, so TUI redraws and scrolling keep the image
attached to its text rows.

The self-contained renderer behaves consistently on Linux, macOS, and Windows.
Invalid TeX, emoji, unsafe HTML/style macros, unsupported terminals, and
incomplete streamed delimiters fall back to the original Markdown instead of
failing the turn. Set `PSS_LATEX=0` to disable rendering,
`PSS_LATEX_COLOR=#202020` to choose the six-digit foreground color (useful for
light terminal themes), `PSS_LATEX_SCALE=0.9` to tune formula size from `0.5`
to `2`, `PSS_LATEX_ASPECT=1.05` for a small terminal-specific horizontal
correction from `0.75` to `1.25`, or `PSS_LATEX_CACHE_DIR` to override the PNG
cache.
Model-generated formulas run without shell escape, browser, network access, or
TeX filesystem input. Unsafe HTML/style macros and emoji are rejected, while
SVG/PNG bytes, dimensions, pixels, and render queues are bounded. The worker
has conservative Node heap and stack limits; a 10-second timeout, cancellation,
or worker failure terminates it, falls back to source Markdown, and lets the
next formula start a fresh worker. These are Node worker heap/time limits, not
hard CPU or OS address-space limits.

### Mermaid diagrams in the TUI

Mermaid support is a built-in extension that ships inside the
coding-agent package, included by default and registered
as the outermost fallback assistant renderer after LaTeX.

Complete ```` ```mermaid ```` fenced blocks keep their original source visible
and get a Unicode box-art rendering appended directly below, following the pi
ecosystem's `pi-mermaid` convention. Rendering runs in a bounded Node
worker (5-second timeout, 256 MB heap cap) via `beautiful-mermaid`: no
browser, DOM shim, image protocol, disk cache, or network access, so it
works in every terminal.
Flowchart, sequence, state, class, ER, and XY-chart diagrams are supported,
and wide East Asian label characters keep box borders aligned through a
placeholder expansion shim. Unclosed fences while streaming, malformed or
unsupported sources, expansions beyond a complexity budget, and oversized
outputs all fall back to showing only the source fence. Set `PSS_MERMAID=0`
to disable rendering.

## CLI

Update a global install, or preview what an update would do:

```sh
pss update
pss update --check
```

`pss update` re-checks the npm registry's dist-tags and installs the exact
newest version of your channel through the detected package manager
(pnpm/npm/bun/yarn global installs). Your channel follows the installed
version: stable installs track `latest`, and a prerelease like `0.0.14-next.2`
or `1.0.0-beta.3` tracks its own dist-tag (`next`, `beta`, or any published
tag). Moving to stable is explicit:

```sh
pss update --channel latest
```

Any other published dist-tag can be targeted the same way (`pss update
--channel beta`); moving a stable install to a prerelease channel is refused,
and an unknown channel reports the published channel list.

One-off runs (`pnpm dlx`, `npx`, `bunx`) cannot be updated in place; `pss
update` prints the global install command instead.

Inspect the configured local thread without starting the TUI:

```sh
pss inspect-thread
```

The inspection command uses the runtime Node adapter to decode stored thread
snapshots, so the CLI reports the same file path, message count, compaction
records, and version that runtime storage uses.

Run one headless coding task (CI, benchmarks, scripts):

```sh
pss exec --workspace . --prompt "Fix the failing test"
pss exec --workspace . --stdin --timeout-seconds 900 --result-file result.json
```

`pss exec` streams JSONL events (`metadata`, `agent_event`, `result`) to stdout
and exits 0 only when the task completes. Streaming deltas
(`assistant-output-delta`, `assistant-reasoning-delta`, `tool-call-input-*`)
appear as `agent_event` lines alongside the committed events, but are excluded
from the accumulated `result.events` payload, which stays committed-only.
Structured `turn-error` metadata appears in both the live `agent_event` and
committed result without raw provider diagnostics. Flags: `--workspace`; exactly one of
`--prompt`, `--prompt-file`, or `--stdin`; plus `--model`, `--base-url`,
`--timeout-seconds` (1-1200), `--web-tools`, and `--result-file`. A `.env` next
to the working directory is loaded automatically.

Both the TUI and `pss exec` share the same workspace tools through
`createCodingAgent`: `read_file`, `glob_files`, `grep_files`, `edit_file`
(hashline-anchored), `write_file`, `delete_file`, and `shell_execute`. The file
tools are confined to the workspace (path and symlink escapes are rejected).
`shell_execute` is not a sandbox — commands run with the user's permissions,
but AI provider API keys are withheld from the child environment. Untrusted
workloads belong in a container (see `experimental/nextjs-bench`, which runs the agent
in Docker).

Pass `tools` to `startTui` (or `createCodingAgent`) from a custom entrypoint to
replace the optional web tools; the workspace tools are always included.

## Updates

The TUI checks for updates without blocking startup. The cached result in
`~/.pss/update-check.json` (24h TTL) is read before the first render; when it
names a newer version on your channel (or a stable release that surpasses a
prerelease install), one dim line is printed into the scrollback, and a stale
cache is refreshed in the background for the next run. Checks are skipped for
dev/source runs. Set `PSS_DISABLE_UPDATE_CHECK=1` (or `true`) to opt out.

### Auto-update (opt-in)

Set `PSS_AUTO_UPDATE=1` (or `true`) to let pss update itself: when the cached
check names a newer version on your channel and the install is a confidently
detected global install (path-based pnpm/npm/bun/yarn layout), the exact
pinned version is installed after the TUI exits — never during a session,
never across a major version, and never as a channel switch. Ephemeral and
unrecognized installs are skipped, and `PSS_DISABLE_UPDATE_CHECK=1` disables
auto-update as well.

## Web tools availability

The web tools are backed by `@minpeter/opensearch`, which resolves its own
search and fetch providers from the environment (keyed engines such as
TinyFish, Exa, Brave, Tavily, ... via their respective API key variables, plus
keyless fallbacks like DuckDuckGo). No provider API key is required for the
tools to register; `webToolsAvailability` only controls registration:

- `optional` (default) and `required`: register the web tools and let
  OpenSearch pick the best available provider per call.
- `disabled`: never register the web tools.

Provider configuration is read from `openSearchOptions.env` when provided,
otherwise from `process.env`. An injected `client` replaces the OpenSearch
client entirely.

```ts
const tools = createCodingAgentTools({ webToolsAvailability: "required" });

// Custom entrypoint around the TUI defaults:
const tuiTools = resolveStartTuiTools(undefined, {
  webToolsAvailability: "required",
});
```

When the TUI is idle, submitting text starts a normal `thread.send()` turn. When
a run is active, submitting text calls `thread.steer(trimmed)` so the text lands
in the current turn and renders as dim `runtime: ...` input instead of a new human
turn.

## Model providers

`pss exec` and the provider library select an AI SDK adapter from API keys:

| Provider | Selection | Optional model override | Default model |
| --- | --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `claude-sonnet-4-6` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-5.4` |
| OpenAI-compatible | `AI_API_KEY` and optional `AI_BASE_URL` | `AI_MODEL` | existing gateway default |

Existing `AI_*` configurations take priority and are unchanged. Set
`AI_PROVIDER=anthropic|openai|openai-compatible` to choose explicitly; with an
explicit provider, `AI_API_KEY` can be used as the credential and `AI_MODEL`
as the model override. With no key or endpoint, the existing keyless OpenCode
Zen free tier remains the fallback. Provider adapters are dynamically imported,
so unused official SDKs do not load at startup. The interactive TUI currently
retains its OpenAI-compatible session catalog and switching behavior; official
provider auto-selection applies to `pss exec` and the library API.

```ts
import {
  createProviderModelFromEnv,
  PROVIDER_DESCRIPTORS,
} from "@minpeter/pss-coding-agent/providers";

console.table(PROVIDER_DESCRIPTORS);
const model = await createProviderModelFromEnv();
```

OAuth is not part of this API-key-based provider slice.

## Env

Set one of the provider API keys above, or use the legacy `AI_API_KEY`,
`AI_BASE_URL`, and `AI_MODEL` variables.

The TUI persists runtime-owned thread state to files by default:

- `PSS_THREAD_DIR` overrides the store directory. Default: `~/.pss/threads`.
- `PSS_THREAD_KEY` overrides the conversation key. Default: `cwd:<current working directory>`.

Automatic compaction is always on: once the estimated context approaches the
model window, older messages are summarized in the background and the summary
replaces them in future prompts. The full history stays on disk.

  `PSS_MODEL_CONTEXT_WINDOW` overrides the assumed context window in tokens.
  Default: 128000. Compaction triggers at 80% of the window and keeps a
  recent tail of about 40%.

Examples:

```sh
pss
PSS_THREAD_KEY=workspace:demo pss
PSS_THREAD_DIR=.pss/threads pss
PSS_MODEL_CONTEXT_WINDOW=64000 pss
PSS_THREAD_KEY=workspace:demo pss inspect-thread
```

## Dev

```sh
pnpm dev:tui
```
