---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Change

Assistant text still follows its latest eight rendered rows while streaming. On its committed text completion boundary, the active block expands to its full rendered text before becoming an immutable snapshot. Complete tables, code, and verification paragraphs remain in terminal scrollback.

## Boundaries

Reasoning and tool bodies remain bounded. Abort, errors, steering, and other handoffs preserve their current partial display rather than marking it complete. Continuations append separately and never reopen older snapshots. Late reasoning completion cannot seal a newer text block. Custom renderers retain their current output and are disposed once after capture.
