---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Model thread and TUI session lifecycles as explicit state machines

Replace scattered boolean/promise flag combinations with small typed finite
state machines so every lifecycle state is explicit and illegal transitions
fail fast instead of silently corrupting state.

The runtime gains an internal `Fsm` helper (discriminated-union states plus a
validated transition table). `AgentThread` now tracks four orthogonal
machines — lifecycle (`created/starting/started/stopping/stopped`), terminal
(`open/killed/deleting/deleted`), drain (`idle/draining`), and turn
(`none/active/finishing`) — replacing the previous `started`, `killed`,
`running`, `drainRequested` flags and their companion promises.
`ThreadState` persistence follows a
`unloaded/loading/ready/deleting/deleted` machine with an explicit rollback
target when a store delete fails. `BufferedAgentTurn` models its producer
channel (`open/closed`) and consumer delivery
(`unconsumed/idle/waiting/delivering/delivered`) explicitly, and durable
input-claim recovery follows `pending/recovering/recovered`.

The coding-agent TUI replaces its `shouldExit`, `inputResolver`,
`activeRun`, and `activeTurnInterrupted` closure variables with a
`TuiSessionMachine` that models the prompt
(`idle/awaiting/processing/closed`) and the streaming turn (`none/active`)
separately, keeping steering submits routed to the active run while the
prompt keeps waiting. `ExtensionHostLifecycle` tracks
`idle/activating/active/disposed` so agent/mode references cannot exist
outside an activation. Public APIs and observable behavior are unchanged.
