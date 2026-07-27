# RFC 0003: Runtime Hooks and Coding-Agent Extensions

**Status**: Accepted

**Scope**: `packages/runtime`, `apps/coding-agent`, application hosts

**Decision**: Keep atomic interception in the runtime; move multi-extension
composition and UI ownership to application hosts.

## Context

The first runtime extension design placed two responsibilities in
`@minpeter/pss-runtime`:

1. atomic interception at input, model, tool, and compaction boundaries;
2. multi-extension identity, initialization, ordering, timeout, state,
   capability, subscription, and cleanup.

The first responsibility belongs to the execution engine because only the
runtime can apply decisions before persistence or tool execution. The second
belongs to the application host. Keeping both in core duplicated the extension
layer needed by interactive products and made UI contributions impossible
without leaking UI dependencies downward.

Pi uses a low-level agent callback/event API and a coding-agent ExtensionRunner
above it. PSS adopts the same ownership direction while preserving PSS-specific
durable tool checkpoint and model-commit semantics.

## Decision

### Runtime

`@minpeter/pss-runtime` accepts one `AgentHooks` object:

```ts
interface AgentHooks {
  acceptInput?: AgentHook<AgentInputEvent, AgentInputDecision<AgentInputEvent>>;
  beforeTurnStart?: AgentHook<
    AgentTurnStartEvent,
    AgentTransformDecision<AgentTurnStartEvent>
  >;
  transformModelContext?: AgentHook<
    AgentModelContextEvent,
    AgentTransformDecision<readonly ThreadContextMessage[]>
  >;
  transformModelStep?: AgentHook<
    AgentModelStepEvent,
    AgentTransformDecision<ModelStepOutput>
  >;
  beforeToolExecution?: AgentHook<
    RuntimeToolExecutionCheckpoint,
    RuntimeToolExecutionDecision
  >;
  transformToolResult?: AgentHook<
    RuntimeToolExecutionCheckpoint & { readonly output: unknown },
    RuntimeToolExecutionResult
  >;
  beforeCompaction?: AgentHook<
    AgentCompactionEvent,
    AgentCompactionDecision
  >;
}
```

The runtime owns:

- call-site placement;
- snapshot isolation;
- result validation;
- durable tool checkpoint decisions;
- atomic model-step and compaction application;
- hook error attribution through `AgentHookError`.

The runtime does not own:

- extension identity or discovery;
- extension activation and cleanup;
- multiple-extension ordering;
- UI, commands, keybindings, or renderers;
- extension-provided tools;
- extension-scoped state;
- provider middleware.

Lifecycle observations use `AgentTurn.events()` or `AgentInstrumentation`.
Provider interception uses model-provider middleware.

### Coding agent

`@minpeter/pss-coding-agent/extension` owns the higher-level extension host.
Each `CodingAgentExtension` has a stable `id`, a registration-only `configure`
phase, and an optional `activate` phase with reverse-order cleanup.

The extension registry accepts:

- runtime hook contributions;
- tools;
- instruction fragments;
- commands;
- TUI tool renderers.

The host validates duplicate identities and contributions, initializes
extensions sequentially, closes registration after configuration, applies a
bounded activation timeout, and composes all runtime policies into the single
`AgentHooks` object passed to core.

TUI and exec receive the same statically configured extension list. Only TUI
activates command and renderer contributions.

## Dependency direction

```text
@minpeter/pss-runtime
          ↑
@minpeter/pss-coding-agent
          ↑
CodingAgentExtension packages
```

Runtime code never imports coding-agent or TUI types. Coding-agent extensions
may package runtime, application, and TUI facets together, but their runtime
hooks receive no UI context.

## Lifecycle

```text
resolve extension definitions
  → validate stable IDs
  → configure in order
  → close registration
  → compose hooks/tools/instructions
  → create agent
  → activate extensions
  → run TUI or exec
  → dispose agent
  → dispose extensions in reverse order
```

No hot reload, package discovery, dependency solver, or durable
extension-owned state is included in this decision.

## Consequences

- Runtime hooks remain reusable by worker and embedded hosts.
- Coding-agent extensions can pair runtime policy with commands and rendering
  without introducing UI dependencies into core.
- Extension composition errors include a stable extension ID.
- Tool registration moves to the coding-agent extension registry or the
  runtime host's normal `tools` option.
- The previous core factory extension API is removed before stable 1.0 rather
  than preserved as a compatibility layer.

## Verification requirements

- Runtime tests cover every atomic hook boundary and malformed result.
- Coding-agent tests cover registration order, duplicate rejection,
  activation, reverse cleanup, hook chaining, tools, commands, and renderers.
- Worker observability uses instrumentation rather than an extension hook.
- Runtime and coding-agent documentation contain no examples of the removed
  factory extension API.
