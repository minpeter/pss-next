---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Stage /reload extension imports in an isolated module context

`/reload` now evaluates every replacement extension candidate in a
worker-thread module context before anything in the live process is
touched. A candidate that throws at module scope, or exports the wrong
shape, fails the reload during staging — so the live runtime's ESM module
graph and CommonJS cache are only modified once all candidates load
cleanly, and a rolled-back reload can no longer leave freshly re-executed
helper instances observable to the still-running previous runtime through
that window. The staging worker reports the observed export shape
(factory, extension object, or invalid), letting loader validation fail at
staging time exactly as the commit-time import would.

Module side effects run once in the discarded worker context and once more
at commit time; staging trades that repeat execution for keeping the live
module graph untouched on failure. The staging worker keeps the process
alive only while imports are in flight and is terminated when the staging
session ends, and remaining commit-time failures (for example an
activation error after a clean import) continue to use the transactional
CommonJS snapshot/rollback.
