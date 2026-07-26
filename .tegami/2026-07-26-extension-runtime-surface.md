---
packages:
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
untouched and reports the error in chat. `reload` joins the reserved command
names extensions cannot register.

Extension services gain `services.events`, a shared publish/subscribe bus
for extension-to-extension communication. Payloads are JSON values cloned
per delivery, handlers run under the host timeout/abort boundary, and
failures are attributed to the subscribing extension without affecting the
publisher or other subscribers. The `host:` and `provider:` namespaces are
reserved for host-originated events.

The host now publishes read-only provider HTTP observations on the bus:
`provider:request`, `provider:response`, and `provider:error`. URLs are
stripped of credentials and query strings, request bodies and request
headers are never exposed, and response headers pass a safelist. Observation
failures never interrupt provider traffic, and both the TUI and headless
exec wire the observation fetch automatically.
