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
`/models` catalog: `/model` opens a focused inline picker, while
`/model <id>` switches directly for an exact catalog id or opens the picker
prefiltered for a partial id. Switches apply to the live session immediately
— the agent keeps one stable model identity whose underlying provider model
is swapped, so the next step uses the new model without rebuilding the agent
or losing the thread.

Catalogs are cached persistently under `~/.pss/model-catalogs`. Cache files
contain only a timestamp and model ids; their opaque filename hashes the
normalized endpoint and credential, so no raw API key or endpoint is stored.
A fresh catalog is reused for 15 minutes. A catalog up to seven days old is
returned immediately while pss refreshes it in the background, keeping the
picker responsive during temporary provider failures. Writes are atomic,
cache reads reject symlinks/corrupt or oversized files, and Zen applies its
`-free` filter after reading either cache or network data.

`createCodingModelSession`/`createCodingModelSessionFromEnv` expose the
switchable session (current model id, catalog listing, switching) for
embedders, and the free-tier constants are exported from the package
entrypoint.
