---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Stream live tokens in the TUI and `pss exec`

The TUI renders the runtime's streaming deltas as they arrive, so assistant
text and reasoning appear token by token instead of in one block at step end.
Dedupe against the committed events is built in: committed `assistant-output`
text renders only when a step produced no deltas.

`pss exec` forwards delta events to stdout as `agent_event` NDJSON lines
alongside the committed events, but excludes them from the accumulated
`result.events` payload, which stays committed-only. The example packages
print deltas live with a committed-only fallback.
