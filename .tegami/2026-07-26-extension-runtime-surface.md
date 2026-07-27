---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Add /reload, an inter-extension event bus, and provider observations

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
