---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Show provider retry waits in the TUI footer

Render an active `model-retry` schedule in the existing one-row footer status as
a live countdown with the next attempt number and remaining retry budget. The
wait clears on retry start, any stop reason, turn end, abort, error, and session
switches, and is never written to the transcript.
