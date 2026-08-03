---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Harden file ownership and extension mutation transactions

Replace time-expiring local file leases with atomic PID/token-owned locks.
Live processes retain ownership even while suspended, dead owners are reaped
under a separately owned lock, and stale holders cannot release a successor's
lock. The lock explicitly targets one shared PID namespace and a local
filesystem rather than claiming cross-container or distributed-filesystem
safety.

Serialize each extension scope's install, update, remove, enable, and trust
mutations through one operation owner. Package updates validate before
mutation and restore a single install-root snapshot if any package or final
settings commit fails; failed removals likewise restore package bytes before
restoring settings, and failed project trust restores the prior enabled state.
Package-manager subprocesses now have bounded output, a configurable deadline,
and process-group SIGTERM/SIGKILL escalation where supported.

Reload staging now rejects candidate graphs that introduce extension-owned
CommonJS modules before importing them into the live process. Existing
CommonJS cache entries return a restart-required result instead of attempting
unsafe process-wide cache eviction, while ESM reload remains supported.
