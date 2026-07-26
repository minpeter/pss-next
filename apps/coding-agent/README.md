# @minpeter/pss-coding-agent

Model wiring and the `pss` TUI for pss-next. The TUI includes OpenSearch-backed
`web_search` and `web_fetch` tools by default when `TINYFISH_API_KEY` is
configured.

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
  instructions,
  modelProvider,
  threadMigration,
  toolRenderer,
  tools,
  type ExtensionAPI,
} from "@minpeter/pss-coding-agent/extension";

export default function workspacePolicy(pss: ExtensionAPI) {
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
}
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
contributions after the factory resolves. Activation callbacks run after agent
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

## CLI

```sh
pnpm dlx @minpeter/pss-coding-agent
```

```sh
pnpm add -g @minpeter/pss-coding-agent
pss
```

CLI commands: `pss`, `pss-coding-agent`.

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
workloads belong in a container (see `benchmarks/nextjs`, which runs the agent
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

The web tools are backed by `@minpeter/opensearch` and need `TINYFISH_API_KEY`
(one or more `;`-separated keys). `createCodingAgentTools()` gates on the key
before wiring the OpenSearch client, controlled by `webToolsAvailability`:

- `optional` (default): when the key is missing, the web tools are omitted
  instead of advertised, and the omission is reported through
  `onWebToolsDisabled` (default: `console.warn` logs
  `web tools disabled: missing TINYFISH_API_KEY`; the `pss` TUI overrides the
  handler and renders the message as a dim scrollback line at startup).
  Startup still succeeds, so environments without a key behave exactly as
  before minus the unusable tools.
- `required`: throw `CodingAgentWebToolsUnavailableError` during tool/agent
  initialization when the key is missing, so a model can never be offered a
  tool that cannot execute.
- `disabled`: never register the web tools.

The key is read from `openSearchOptions.env` when provided, otherwise from
`process.env`. An injected `client` counts as provider configuration in
`optional` and `required` modes.

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

## Env

Set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` for the model.

The TUI persists runtime-owned thread state to files by default:

- `PSS_THREAD_DIR` overrides the store directory. Default: `~/.pss/threads`.
- `PSS_THREAD_KEY` overrides the conversation key. Default: `cwd:<current working directory>`.

Automatic compaction is always on: once the estimated context approaches the
model window, older messages are summarized in the background and the summary
replaces them in future prompts. The full history stays on disk.

- `PSS_MODEL_CONTEXT_WINDOW` overrides the assumed context window in tokens.
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
