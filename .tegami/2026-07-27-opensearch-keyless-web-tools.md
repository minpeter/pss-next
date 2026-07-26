---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Delegate web tool providers to OpenSearch instead of gating on TinyFish

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
