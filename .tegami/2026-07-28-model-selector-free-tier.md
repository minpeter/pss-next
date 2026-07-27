---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Add a `/model` selector and a keyless free-tier default provider

pss now starts without any configuration. When neither `AI_API_KEY` nor
`AI_BASE_URL` is set, the model environment falls back to the OpenCode Zen
free tier (`https://opencode.ai/zen/v1`, the reserved anonymous key
`public`, default model `mimo-v2.5-free`). `AI_MODEL` still picks a
different free model, an explicit `AI_BASE_URL` without a key still fails
validation so custom endpoints are never silently ignored, and the TUI
shows a startup notice plus a `(free tier)` header tag so the fallback is
never mistaken for a configured provider.

The TUI gains a `/model` command backed by the provider's OpenAI-compatible
`/models` catalog: `/model` opens an interactive picker (or prints the list
when no overlay UI is available), `/model <id>` switches directly with
catalog validation, and `/model list` prints the catalog. Switches apply to
the live session immediately — the agent keeps one stable model identity
whose underlying provider model is swapped, so the next step uses the new
model without rebuilding the agent or losing the thread.

`createCodingModelSession`/`createCodingModelSessionFromEnv` expose the
switchable session (current model id, catalog listing, switching) for
embedders, and the free-tier constants are exported from the package
entrypoint.
