---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Generate titles for new coding sessions

Use the active conversation model and cache-friendly first-turn context to name unnamed sessions, with a prompt-text fallback and protection for manually assigned names.
