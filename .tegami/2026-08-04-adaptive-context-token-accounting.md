---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Add adaptive context token accounting

Measure provider-visible prompts in the runtime and calibrate estimates from
reported usage so context gating, compaction, and TUI usage stay aligned.
