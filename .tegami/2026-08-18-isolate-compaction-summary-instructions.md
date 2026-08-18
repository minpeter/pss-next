---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Isolate compaction summarize from agent instructions

Stop forwarding `model.instructions` into the compaction summary model call so
agent persona/policy prompts (including reminder silence rules) cannot suppress
handoff summary output. The compaction contract remains the sole instruction
source via the leading system history message.
