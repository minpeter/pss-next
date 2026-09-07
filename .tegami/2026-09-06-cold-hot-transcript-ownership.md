---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Freeze completed TUI output

Keep the startup header and completed transcript immutable, with only the latest output block live. Interleaved tools and steering append continuations; extension prompts stay inline, and late renderer callbacks cannot rewrite history.
