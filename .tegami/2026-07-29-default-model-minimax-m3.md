---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Default to minimax/MiniMax-M3

The fallback model id used when `AI_MODEL` is unset moves from
`minimax/MiniMax-M2.7` to `minimax/MiniMax-M3`. Set `AI_MODEL` to pin the
previous model.
