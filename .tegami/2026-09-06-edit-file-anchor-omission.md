---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Clarify edit_file anchor selection

Explicitly disable strict tool generation for edit_file, correct its anchor examples, and explain that unused anchor keys must be omitted entirely. Conflicting anchors still fail without writing, with actionable guidance for retrying.
