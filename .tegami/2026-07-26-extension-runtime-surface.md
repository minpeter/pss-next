---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Add /reload, an inter-extension event bus, and provider observations

The TUI gains a `/reload` command that rebuilds the extension runtime from
disk without restarting the session. Extensions are rediscovered across
managed installs, local modules, and `-e` paths, re-imported past the module
cache, and activated against a replacement agent while the durable thread
keeps its history. The swap is fail-safe: the replacement host, agent,
command set, and renderer set are fully constructed and activated before
anything is swapped, so a failing reload leaves the current session
untouched and reports the error in chat. Reload cache busting propagates
through the extension-owned module graph via a module customization hook,
including CommonJS helpers, so edited sibling modules are re-imported too;
CommonJS eviction is transactional and restored when a reload fails, and
dependencies under `node_modules` keep their loaded versions so repeated
reloads do not accumulate duplicate dependency graphs. Cleanup of the
previous runtime is bounded by a timeout so an unresponsive extension
cannot hang the reload command.
The runtime exports `validateThreadStateMigrations` and `/reload` uses it to
prove reloaded migrations accept the stored thread before the swap commits;
a failed reload also refreshes the surviving thread handle so replacement
activation writes cannot strand the old session on a stale revision.
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
