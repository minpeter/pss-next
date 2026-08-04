---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Describe LINE#ID anchors in the edit tool schemas

Add Zod field descriptions so `read_file` and `edit_file` expose the LINE#ID anchor format in their JSON Schema.
Export `./instructions` and `./workspace-tools` subpaths for the edit-format benchmark.
