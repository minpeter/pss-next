---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Improve resume autocomplete responsiveness

Match displayed session labels during `/resume` completion, show progress while sessions load, and cache resumable session discovery so subsequent keystrokes respond immediately.
