---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Make edit_file anchors symmetric

Use `target` for one line or `first` and `last` for ranges, with non-empty `new_content`.
Align the edit benchmarks with the real tool contract and add deterministic multi-file recovery coverage.
